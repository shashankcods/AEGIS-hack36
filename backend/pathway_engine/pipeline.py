import pathway as pw
import redis
import json
import time

class ScoreSchema(pw.Schema):  # defining the structure of input
    score: float
    label: str

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

class RedisSingleValueWriter(pw.io.python.ConnectorObserver):  # output connector to write a single value to redis
    def __init__(self, host='localhost', port=6379, key=""): 
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
            value_to_write = next(iter(row.values())) # get the first (and only) value from the row
            try:
                self.rd.set(self.key, value_to_write)
                print(f"Updated simple value in Redis at key '{self.key}' to: {value_to_write}")
            except redis.exceptions.ConnectionError as e:
                print(f"RedisSingleValueWriter: Could not write to Redis. Error: {e}")

    def on_end(self):
        print("Stream has ended. RedisSingleValueWriter closing.")

class RedisJsonDictWriter(pw.io.python.ConnectorObserver):  
    def __init__(self, host='localhost', port=6379, key=""):
        super().__init__()
        self.host = host
        self.port = port
        self.key = key 
        self.current_state = {}  
        try:
            self.rd = redis.Redis(host=self.host, port=self.port, decode_responses=True)
            self.rd.ping()
            print(f"RedisJsonDictWriter: Connected to Redis. Will write to key '{self.key}'")
        except redis.exceptions.ConnectionError as e:
            print(f"RedisJsonDictWriter: FAILED to connect. Error: {e}")
            raise

    def on_change(self, key, row, time, is_addition):  # key is the Pointer, row is the data

        if is_addition:  
            self.current_state[key] = row
        else:
            self.current_state.pop(key, None)
        
        output_dict = {}  # creating a dictionary for json output
        for row_data in self.current_state.values():
            label_key = row_data['label'] 
            output_dict[label_key] = row_data  # using label 
        
        try:
            json_data = json.dumps(output_dict) 
            self.rd.set(self.key, json_data)
            print(f"Updated JSON Dict in Redis at key '{self.key}'")
        except redis.exceptions.ConnectionError as e:
            print(f"RedisJsonDictWriter: Could not write to Redis. Error: {e}")

    def on_end(self):
        print("Stream has ended. RedisJsonDictWriter closing.")


def run_pipeline():  # constructing and running the pipeline
    print("Pathway pipeline starting...")

    t_scores = pw.io.python.read(
        RedisScoreReader(host='localhost', port=6379, list_key='scores_stream'),
        schema=ScoreSchema,
        autocommit_duration_ms=1000
    )
    
    t_grouped_global = t_scores.groupby()
    
    t_global_stats_base = t_grouped_global.reduce(  # calculating global statistics in one reduction
        average_score=pw.reducers.avg(pw.this.score),
        highest_score=pw.reducers.max(pw.this.score),
        lowest_score=pw.reducers.min(pw.this.score),
        total_scores=pw.reducers.count(),

        count_low=pw.reducers.sum(pw.if_else(pw.this.score <= 50, 1, 0)),  # score distribution brackets
        count_medium=pw.reducers.sum(pw.if_else((pw.this.score > 50) & (pw.this.score <= 90), 1, 0)),
        count_high=pw.reducers.sum(pw.if_else(pw.this.score > 90, 1, 0)),
    )

    t_global_stats = t_global_stats_base.with_columns(  # percentage of scores that are "high"
        percent_high_score=pw.if_else(
            pw.this.total_scores > 0,
            (pw.this.count_high / pw.this.total_scores) * 100,
            0  # Default to 0 if total_scores is 0
        )
    )
    
    # --- writing all 9 global stats to redis ---
    pw.io.python.write(
        t_global_stats.select(pw.this.average_score),
        RedisSingleValueWriter(host='localhost', port=6379, key='current_average')
    )
    pw.io.python.write(
        t_global_stats.select(pw.this.highest_score),
        RedisSingleValueWriter(host='localhost', port=6379, key='highest_score')
    )
    pw.io.python.write(
        t_global_stats.select(pw.this.lowest_score),
        RedisSingleValueWriter(host='localhost', port=6379, key='lowest_score')
    )
    pw.io.python.write(
        t_global_stats.select(pw.this.total_scores),
        RedisSingleValueWriter(host='localhost', port=6379, key='total_scores')
    )
    pw.io.python.write(
        t_global_stats.select(pw.this.count_low),
        RedisSingleValueWriter(host='localhost', port=6379, key='count_low')
    )
    pw.io.python.write(
        t_global_stats.select(pw.this.count_medium),
        RedisSingleValueWriter(host='localhost', port=6379, key='count_medium')
    )
    pw.io.python.write(
        t_global_stats.select(pw.this.count_high),
        RedisSingleValueWriter(host='localhost', port=6379, key='count_high') # Replaces old 'high_score_count'
    )
    pw.io.python.write(
        t_global_stats.select(pw.this.percent_high_score),
        RedisSingleValueWriter(host='localhost', port=6379, key='percent_high_score')
    )

    # --- per label statistics ---
    t_grouped_by_label = t_scores.groupby(pw.this.label)
    
    t_label_stats = t_grouped_by_label.reduce(
        label=pw.this.label, 
        count=pw.reducers.count(),
        avg_score=pw.reducers.avg(pw.this.score),
        max_score=pw.reducers.max(pw.this.score),
        min_score=pw.reducers.min(pw.this.score)
    )
    t_label_stats_with_id = t_label_stats.with_id_from(pw.this.label)

    pw.io.python.write(
        t_label_stats_with_id,
        RedisJsonDictWriter(host='localhost', port=6379, key='stats_by_label')
    )

    t_unique_label_count = t_label_stats.groupby().reduce(
        unique_label_count=pw.reducers.count()
    )
    
    pw.io.python.write(
        t_unique_label_count.select(pw.this.unique_label_count),
        RedisSingleValueWriter(host='localhost', port=6379, key='unique_label_count')
    )

    print("Running Pathway pipeline with all new analytics...")
    pw.run() 

if __name__ == "__main__":
    run_pipeline()