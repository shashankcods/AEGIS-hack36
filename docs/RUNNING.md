# Running AEGIS locally

## What is integrated

The running API now loads the CSV-trained V2 exports, not the original model
directories:

| Task | Default directory | Positive label in saved model | API label |
| --- | --- | --- | --- |
| Health disclosure | `backend/ml_service/notebooks/disease_model_v2` | `HEALTH_DISCLOSURE` | `health_disclosure` |
| Self-harm disclosure | `backend/ml_service/notebooks/self_harm_model_v2` | `SELF_HARM_DISCLOSURE` | `self_harm_disclosure` |

Each directory must contain the tokenizer, `config.json`, and model weights.
Exports and weights are ignored by Git. On another machine, run the respective
V2 notebook or copy its complete export directory. Do not copy only the weights.
The runtime validates the saved label mappings; it does not assume `LABEL_1`.
This integration uses the already-trained exports and does not retrain them.

GLiNER uses `nvidia/gliner-pii`. PaddleOCR reads supported images and PDF pages.
Initial loading may download those pretrained resources if they are not cached.
Submitted content is processed locally, not sent to an external inference API.

## First-time setup

Use Python 3.11 for a new environment. The existing project `venv` can also run
the default stack without Pathway.

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Install Redis and Poppler if missing. On macOS:

```bash
brew install redis poppler
```

On Ubuntu, install the `redis-server` and `poppler-utils` packages. PaddleOCR also
needs the platform's OpenCV system libraries. Use a recent Node.js version for
the extension's Vite build.

From the project root:

```bash
python3 scripts/run_local.py
```

The launcher selects a complete local Python environment, starts a loopback-only
Redis server if necessary, starts the result consumer and portable analytics
worker, and starts Django on port 8000. Model/OCR loading happens before startup
is reported as ready. Logs and launcher-owned Redis persistence are stored under
`.runtime/`; the project's existing `dump.rdb` is not used or overwritten.
Ctrl+C stops only processes created by this launcher, not an existing Redis server.
Do not run a second launcher against the same Redis database: each queue has one
worker lease.

For text-only development when OCR dependencies are unavailable:

```bash
python3 scripts/run_local.py --skip-ocr-warmup
```

This skips loading OCR at startup, not file checks. A later upload still requires
working OCR. `--no-warmup` skips all startup model loading; missing resources will
then be reported on the first check.

## Load the extension

```bash
cd extension
npm install
npm test
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select `extension/dist`. Reload the extension and the ChatGPT/Gemini tab after a
rebuild. The production build does not need Vite's development server.

The extension calls `http://127.0.0.1:8000`. The launcher's `--port` option is for
API testing; the extension URL must also be changed and rebuilt to use another
port. The extension's permissions cover ChatGPT, Gemini, and the local backend.
See [extension usage](../extension/README.md) for attachment staging limitations.

## Request flow and scores

1. The extension captures the whole supported prompt and staged images/PDFs.
2. Django validates all inputs and analyzes typed text **and every file**.
3. OCR extracts text; both V2 classifiers and GLiNER inspect it.
4. Overlapping chunks cover long input. The strongest positive confidence across
   chunks is retained, and duplicate categories are merged.
5. The response immediately contains detections. Redis receives category-only
   result and analytics jobs, never the prompt or extracted personal values.
6. The consumer stores a five-minute session summary. The analytics worker
   updates durable counters and acknowledges each queued event atomically.
7. The extension displays warnings; its popup reads actual statistics.

`confidence` is a model output score. It is not a calibrated safety probability.
`sensitivity_score` is the configured category risk weight, from 0 to 1. The
default health/self-harm weights are 0.6 and 1.0. Analytics use this sensitivity,
not confidence. Buckets are low at or below 0.5, medium above 0.5 through 0.8, and
high above 0.8. Dashboard counts represent **detected category events**, not unique
prompts or users; repeated checks contribute repeated events.

The default model threshold is 0.5. The API accepts a finite threshold from 0 to 1.
This is not evidence that 0.5 is optimal; choosing deployment thresholds requires
separate validation and calibration.

## Configuration

Set variables in the shell before starting; the launcher does not load `.env`.

| Variable | Default / purpose |
| --- | --- |
| `AEGIS_PYTHON` | Explicit backend Python executable |
| `AEGIS_HEALTH_MODEL_PATH` | Complete health V2 export directory |
| `AEGIS_SELFHARM_MODEL_PATH` | Complete self-harm V2 export directory |
| `AEGIS_GLINER_MODEL` | `nvidia/gliner-pii`, or a local GLiNER export |
| `AEGIS_ALLOW_MODEL_DOWNLOAD` | `1`; set `0` to prevent GLiNER download fallback |
| `AEGIS_REDIS_URL` | `redis://127.0.0.1:6379/0`, shared by API and workers |
| `AEGIS_TORCH_THREADS` | `4` CPU inference threads |
| `AEGIS_MAX_PDF_PAGES` | `10`, reject larger PDFs rather than silently skipping pages |
| `DJANGO_DEBUG` | `false` |
| `DJANGO_ALLOWED_HOSTS` | Loopback hosts only |
| `DJANGO_SECRET_KEY` | Local development value; replace for any deployment |

Restart the backend after changing model files or model configuration. Components
are cached once loaded; a failed load is not repeatedly retried on every prompt.
For a fully offline launch, all model/OCR resources must already be cached.

## API and worker commands

- `POST /api/analyze/`: JSON text/base64 image, or multipart text and image/PDF files.
- `GET /api/get_results/?session_id=...`: 202 pending, 200 processed summary, or an
  explicit background-processing error.
- `GET /api/stats/`: atomic category analytics snapshot, scores from 0 to 1.
- `GET /api/health/`: model, Redis, and live worker readiness independently.
- `GET /api/health/?load=1&ocr=1`: load and check every inference component.
- `POST /api/score/`: validated category analytics event, `score` from 0 to 1.

For separate terminals, activate the backend environment and run from `backend`:

```bash
python manage.py runserver 127.0.0.1:8000 --noreload
python -m pathway_engine.consumer
python -m pathway_engine.analytics
```

Run each command in its own terminal. If using Django admin/authentication,
initialize its tables with `python manage.py migrate`; inference/Redis endpoints
do not require database tables.

Optional Pathway requires a compatible Python 3.10+ environment and the additional
`requirements-pathway.txt` dependency. Run `python -m pathway_engine.pipeline`
**instead of** `python -m pathway_engine.analytics`. Both share canonical durable
Redis state and normalized scores. The existing Python 3.9 environment does not
have Pathway installed; the portable worker is the default tested runtime.

## Verification

Replace `venv/bin/python` with `.venv/bin/python` if using the new environment.

```bash
PYTHONPATH=backend venv/bin/python -m unittest ml_service.test_pii_detection pathway_engine.test_workers -v
venv/bin/python backend/manage.py test ML_api.tests --verbosity 2
venv/bin/python scripts/smoke_test.py --files
```

The smoke test uses the real loaded weights, OCR, HTTP API, Redis queues, and
analytics. Its synthetic checks generate analytics events. To keep them out of
the ordinary dashboard, use a separate Redis instance/database and API port:

```bash
AEGIS_REDIS_URL=redis://127.0.0.1:6387/15 python3 scripts/run_local.py --port 8017
venv/bin/python scripts/smoke_test.py --base-url http://127.0.0.1:8017 --files
```

Worker unit tests create their own temporary Unix-socket Redis instance rather
than deleting or flushing an existing Redis database.

## Limits and honest expectations

- Both V2 classifiers are required. Missing or failing classifiers return an
  error, not an empty successful result. GLiNER failure returns a clearly marked
  partial check. OCR failure is explicit; it is not treated as a clean file.
- Redis is optional for immediate detections, but required for summaries and
  analytics. Worker heartbeats expose stopped processors even if Redis is up.
- Inputs are limited to 8 MB per request, 100,000 extracted text characters,
  20-megapixel source images, ten files, and ten PDF pages by default. Multipart
  framing contributes to the request-size limit. Multi-frame images and other
  document formats are not supported.
- Raw uploads may use Django's temporary-file handling for larger multipart
  files. This is local processing, not a guarantee that data never touches disk.
- The models remain prototypes trained on a small curated dataset. Real smoke
  checks exposed false positives, including a medication statement flagged by
  the self-harm classifier. Successful integration does not prove deployment
  accuracy or clinical suitability. Long-input chunking is not a substitute for
  evaluating long conversations.
- The extension warns and does not block submissions. Browser-side checks cannot
  prevent a user from sending a prompt before analysis finishes. Host-site UI
  changes can also require selector updates; live browser behavior needs checking
  after loading the rebuilt extension.
- Keep this development service on localhost. Public deployment needs separate
  authentication, rate limits, transport security, and deployment hardening.
