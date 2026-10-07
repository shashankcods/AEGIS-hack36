<h1 align="center">AEGIS — Secure Prompting Practices</h1>
<p align="center">
A browser extension that warns about sensitive information in prompts and attachments before users share them with ChatGPT or Gemini.
</p>

[![Built at Hack36](https://raw.githubusercontent.com/nihal2908/Hack-36-Readme-Template/main/BUILT-AT-Hack36-9-Secure.png)](https://raw.githubusercontent.com/nihal2908/Hack-36-Readme-Template/main/BUILT-AT-Hack36-9-Secure.png)

---

## Introduction:
**AEGIS** sends supported prompts and attachments to a locally hosted Django backend. GLiNER detects PII categories, while two locally fine-tuned DistilRoBERTa classifiers detect health and self-harm disclosures. Images and PDFs are processed with PaddleOCR.

Redis connects the API to result processing and sensitivity analytics. The default analytics worker works in the existing Python environment; an optional Pathway adapter is also available. Results contain categories and scores, not the detected personal values. This is a warning prototype, not a submission blocker or clinical system.

The system operates as a **CRXJS + React + TypeScript** extension, observing user input in browser environments and providing detailed visual insights through a clean popup UI.

## Run locally

With the backend dependencies and the exported V2 model directories present:

```bash
python3 scripts/run_local.py
```

This starts Redis if needed, the result consumer, analytics, and Django on
`http://127.0.0.1:8000`, then loads the models and OCR. Build the extension with
`npm install` and `npm run build` in `extension`, and load `extension/dist` using
Chrome's **Load unpacked** button. Reload any open ChatGPT/Gemini tabs.

See [local setup and verification](docs/RUNNING.md) for first-time installation,
model paths, worker options, tests, and known limitations.

---

## Demo Video Link:
<a href="#">Demo Video Link</a>

---

## Presentation Link:
<a href="https://docs.google.com/presentation/d/10vXArIEf-o9x8L8SwAFzW25JaCazC9Aice8XeP9UAkM/edit?usp=sharing">View Presentation</a>

---

## Table of Contents:
1. Introduction  
2. Core Features  
3. Technology Stack  
4. Contributors  
5. Made at Hack36  

---

## Core Features

### 1. Real-Time Input Monitoring  
- Observes and captures user text inputs dynamically using efficient `MutationObserver` logic.  
- Automatically detects edits and new entries in web input fields.

---

### 2. Privacy-First Architecture  
- Raw text and supported attachments are sent to the local backend for inference. Encoding is not anonymization or encryption.
- API results and Redis jobs contain category labels and scores, not raw prompts or personal values.
- The extension does not persist or print prompt previews. Keep the development API bound to localhost.

---

### 3. Popup Dashboard (React UI)  
- A modern, minimalist popup showing:
  - **Average, high, and low sensitivity scores**
  - **Flagged inputs and unique labels**
  - **Visual indicators (bars and cards) for better readability**
- Built using **React + TypeScript + CRXJS** for Chrome Manifest V3.

---

### 4. Pathway + Django + Redis Integration  
- Background service worker sends structured capture data to the backend.  
- **Analytics worker:** aggregates category sensitivity events; Pathway is an optional alternative runtime.
- **Django backend:** handles inference, input validation, REST APIs, and readiness/statistics endpoints.
- **Redis bridge:** connects Django and Pathway for real-time, low-latency data exchange.

---

### 5. Explicit Failure Handling
- Missing classifiers, unreadable files, and partial PII checks are reported instead of being presented as an empty successful result.
- Immediate detections remain available if Redis is offline; analytics and background summaries show separate availability.
- Per-tab requests suppress stale responses while prompts change.

---

## Technology Stack:
1. **Frontend / Extension:** React + TypeScript + CRXJS (Vite)  
2. **Browser Layer:** Chrome Extensions Manifest V3  
3. **Backend:** Django REST Framework + Pathway  
4. **Data Bridge:** Redis  
5. **Communication:** Chrome Runtime Messaging API  
6. **Styling:** Minimal grey/white theme (CSS)

---

## Contributors:

**Team Name:** Figma Boys

- [Shashank Lakkarsu](https://github.com/shashankcods)  
- [Harish Raju](https://github.com/kyrolxg)  
- [Shabbeer Mohammed](https://github.com/shabbeer2513)  
- [Mogith Pushparaj](https://github.com/MogithX11)

---

## Made at:
[![Built at Hack36](https://raw.githubusercontent.com/nihal2908/Hack-36-Readme-Template/main/BUILT-AT-Hack36-9-Secure.png)](https://raw.githubusercontent.com/nihal2908/Hack-36-Readme-Template/main/BUILT-AT-Hack36-9-Secure.png)
