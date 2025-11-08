import pathway as pw
import redis
import json
import time

# --- Step 1: Define the Input Schema ---
class ScoreSchema(pw.Schema):  # defining the structure of input
    score: float
    label: str  # added label to the schema

# --- Step 2: Create the Custom Input Connector (Redis Reader) ---
class RedisScoreReader(pw.io.python.ConnectorSubject):  # python connector that reads from redis
    def __init__(self, host='localhost', port=6379, list_key="scores_stream"):
        super().__init__()
        self.host = host
        self.port = port
        self.list_key = list_key

    def run(self):
        """This method runs in a separate thread, managed by Pathway."""
        print(f"RedisScoreReader: Connecting to {self.host}:{self.port}...")
        
        while True:
            try:
                self.rd = redis.Redis(host=self.host, port=self.port, decode_responses=True)  # establishing connection
                self.rd.ping()  # to test connection
                print(f"RedisScoreReader: Connected. Listening to list '{self.list_key}'...")
            
                while True:  # loop that listens to pop
                    source_list, data = self.rd.blpop(self.list_key)  # to wait for a new line to arrive
                    
                    try:
                        payload = json.loads(data)  # parsing the incoming JSON
                        # self.next() sends the data into the Pathway pipeline
                        # updated to send both score and label
                        self.next(score=payload['score'], label=payload['label'])
                    except json.JSONDecodeError:
                        print(f"Warning: Received invalid JSON: {data}")
                    except KeyError:
                        print(f"Warning: Received JSON missing 'score' or 'label': {data}")

            except redis.exceptions.ConnectionError as e:
                print(f"RedisScoreReader connection error: {e}. Retrying in 5 seconds...")
                time.sleep(5)
            except Exception as e:
                print(f"RedisScoreReader encountered an unexpected error: {e}")
                break 
        
        print("RedisScoreReader is closing.")

# --- Step 3: Create Output Connectors ---

class RedisSingleValueWriter(pw.io.python.ConnectorObserver):  # output connector to write a single value to redis
    def __init__(self, host='localhost', port=6379, key=""): # key is now an argument
        super().__init__()
        self.host = host
        self.port = port
        self.key = key  # the redis key we will write to
        try:
            self.rd = redis.Redis(host=self.host, port=self.port, decode_responses=True)
            self.rd.ping()
            print(f"RedisSingleValueWriter: Connected to Redis. Will write to key '{self.key}'")
        except redis.exceptions.ConnectionError as e:
            print(f"RedisSingleValueWriter: FAILED to connect to Redis at {self.host}:{self.port}. Error: {e}")
            raise

    def on_change(self, key, row, time, is_addition):  # method called whenever the value updates
        if is_addition:  # to only act when values are inserted
            # 'row' is a dict, we get the first (and only) value from it
            value_to_write = next(iter(row.values()))
            try:
                self.rd.set(self.key, value_to_write)
                print(f"Updated simple value in Redis at key '{self.key}' to: {value_to_write}")
            except redis.exceptions.ConnectionError as e:
                print(f"RedisSingleValueWriter: Could not write to Redis. Error: {e}")

    def on_end(self):
        print("Stream has ended. RedisSingleValueWriter closing.")


class RedisTopKWriter(pw.io.python.ConnectorObserver):  # new output connector for Top-K lists
    def __init__(self, host='localhost', port=6379, key=""):
        super().__init__()
        self.host = host
        self.port = port
        self.key = key  # the redis key we will write the JSON list to
        self.current_state = {}  # internal dictionary to hold the current top-k
        try:
            self.rd = redis.Redis(host=self.host, port=self.port, decode_responses=True)
            self.rd.ping()
            print(f"RedisTopKWriter: Connected to Redis. Will write to key '{self.key}'")
        except redis.exceptions.ConnectionError as e:
            print(f"RedisTopKWriter: FAILED to connect to Redis. Error: {e}")
            raise

    def on_change(self, key, row, time, is_addition):  # method called for every change in the top-k
        if is_addition:
            # if a row is added (enters top-k), add it to our dictionary
            self.current_state[key] = row
        else:
            # if a row is removed (drops out of top-k), remove it
            self.current_state.pop(key, None)
        
        # after every change, update Redis with the full list
        try:
            # convert the dictionary's values (the rows) into a list
            output_list = list(self.current_state.values())
            # convert the list into a JSON string
            json_data = json.dumps(output_list)
            # set the key in Redis to the new JSON string
            self.rd.set(self.key, json_data)
            print(f"Updated Top-K list in Redis at key '{self.key}'")
        except redis.exceptions.ConnectionError as e:
            print(f"RedisTopKWriter: Could not write to Redis. Error: {e}")

    def on_end(self):
        print("Stream has ended. RedisTopKWriter closing.")


# --- Step 4: Build and Run the Pipeline ---
def run_pipeline():  # constructing and running the pipeline
    print("Pathway pipeline starting...")

    # t_scores is the input table, now with 'score' and 'label'
    t_scores = pw.io.python.read(  # reading from the redis reader
        RedisScoreReader(host='localhost', port=6379, list_key='scores_stream'),
        schema=ScoreSchema,
        autocommit_duration_ms=1000
    )

    # --- Branch 1: Global Average Score (Same as before) ---
    t_grouped_global = t_scores.groupby()  # group all rows into one
    t_reduced_global = t_grouped_global.reduce(
        average_score=pw.reducers.avg(pw.this.score)  # calculate average
    )
    t_average_out = t_reduced_global.select(pw.this.average_score)

    pw.io.python.write(  # writing result to redis
        t_average_out,
        RedisSingleValueWriter(host='localhost', port=6379, key='current_average')
    )

    # --- Branch 2: Top 3 Labels by Frequency ---
    
    # group all rows by their 'label'
    t_grouped_by_label = t_scores.groupby(pw.this.label)
    
    # for each label group, count the number of rows
    t_label_counts = t_grouped_by_label.reduce(
        count=pw.reducers.count()
    )
    # t_label_counts table now has columns: 'label' and 'count'

    # *** THIS IS THE FIX: .top_k() instead of .topk() ***
    t_top_3_freq = t_label_counts.top_k(3, by=pw.this.count)

    pw.io.python.write(  # writing result to redis
        t_top_3_freq,
        RedisTopKWriter(host='localhost', port=6379, key='top_3_labels_by_frequency')
    )

    # --- Branch 3: Top 3 Labels by Average Score ---
    
    # we can reuse 't_grouped_by_label' from Branch 2
    
    # for each label group, calculate the average 'score'
    t_label_avg_scores = t_grouped_by_label.reduce(
        avg_score=pw.reducers.avg(pw.this.score)
    )
    # t_label_avg_scores table now has columns: 'label' and 'avg_score'

    # *** THIS IS THE FIX: .top_k() instead of .topk() ***
    t_top_3_score = t_label_avg_scores.top_k(3, by=pw.this.avg_score)

    pw.io.python.write(  # writing result to redis
        t_top_3_score,
        RedisTopKWriter(host='localhost', port=6379, key='top_3_labels_by_score')
    )

    print("Running Pathway pipeline with 3 output branches...")
    pw.run() # this runs all defined branches

if __name__ == "__main__":
    run_pipeline()