# AEGIS browser extension

AEGIS checks prompts and selected images/PDFs on ChatGPT and Gemini using the
local Django backend at `http://127.0.0.1:8000`. Start the backend before using it.

## Install and build

```bash
npm install
npm test
npm run build
```

Open `chrome://extensions`, enable Developer mode, and load this folder's `dist`
directory as an unpacked extension. After rebuilding, reload the extension and
the ChatGPT/Gemini tab. Use a current Node.js release compatible with Vite 7.

For development, `npm run dev` builds the extension with Vite's development
server. The production build does not depend on that server.

## Privacy checks

The panel checks the whole prompt after typing pauses. File selection, image
paste, and file drop also schedule a check, even when there is no text. All
selected files and the current text are analyzed together. Total attachment
transfer is limited to 8 MB; oversized files show an explicit warning. Requests
have a 120-second overall deadline and only transient failures are retried.

The panel shows readable sensitive categories and their sensitivity percentages.
An unavailable model, failed OCR, or disconnected backend is shown as an error
or partial check. An empty detection list does not mean the content is guaranteed
safe. This is a warning tool; it does not block sending a prompt.

`Clear from AEGIS` removes a file from AEGIS's next check, not from the website's
own attachment list. If you remove an attachment on the website, clear its AEGIS
entry as well. The extension clears staged attachments when it observes prompt
submission or navigation to a different conversation. `Check now` explicitly
rechecks the current content.

The extension popup reads actual `/api/stats/` analytics and `/api/health/` model
readiness. Analytics need Redis and the analytics processor; text classification
can still work when those services are offline. Counts represent detected
category events, not the number of prompts. Sensitivity scores are converted from
0–1 to percentages; model confidence is a separate value.

Prompt text and file contents are transferred only to the local backend. The
extension keeps only temporary metadata and category logs in memory. It does not
persist or print prompt previews. Existing prompt-preview caches from earlier
versions are removed when the service worker starts.

## Regression tests

`npm test` covers multipart text + multiple files, transfer failures and limits,
HTTP retry policy, request timeouts, per-tab latest-request handling, metadata
privacy, model-readiness responses, and category/percentage formatting.
