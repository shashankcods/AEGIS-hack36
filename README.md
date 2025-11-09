# AEGIS — Secure Prompting Practices

## Project Summary

**AEGIS** is a privacy-first browser extension that captures, analyzes, and securely transmits text and file inputs from web environments for intelligent data monitoring and sensitivity detection.  

It integrates with a **Django + Pathway backend** to perform **real-time content analysis** — detecting personally identifiable information (PII), evaluating sensitivity levels, and enforcing privacy-first handling throughout the data flow.

The system operates as a **CRXJS + React + TypeScript** extension that runs directly inside the browser, observing user input in target web interfaces.  
Captured data is displayed through an interactive pop-up UI and sent securely to the backend for event-driven analytics.

---

## Core Features

### 1. Real-Time Input Monitoring
- Observes and captures text entered into designated input areas.
- Detects changes dynamically using efficient `MutationObserver` logic.

---

### 2. Privacy-First Architecture
- All capture logic runs locally in the browser sandbox.
- Sends only sanitized, encoded data to the background or backend.
- Adheres to **privacy-by-design** and **data minimization** principles. 

---

### 3. Developer Overlay (Live Debug View)
- Displays a real-time overlay on web pages showing:
  - Captured text
  - Attached file names and sizes
- Assists developers in verifying capture behavior instantly.
  
---

### 4. Popup Dashboard (React UI)
- Clean, minimalist popup interface featuring:
  - **Sensitivity metrics:** average, high, low scores.
  - **Summaries:** total flagged inputs, unique labels.
  - **Visual indicators:** progress bars and count cards.
- Built using React + TypeScript with CRXJS for compatibility with Chrome MV3.

---

### 5. Pathway + Django + Redis Integration
- Background service worker sends structured capture data to the backend.
- **Pathway pipeline:** performs live sensitivity scoring and event aggregation.
- **Django backend:** stores logs, provides REST endpoints, and manages API communication.
- **Redis bridge:** acts as the real-time message broker between Django and Pathway, ensuring
  seamless, low-latency data flow between capture ingestion and live analysis.

### 6. Robust Data Logging
- Each capture event includes:
  - Source (manual, automatic, paste, upload)
  - Associated metadata
- Reliable message passing between:
  - **Content Script → Background Script → Backend**

---

## Technology Stack

| Layer | Technology |
|-------|-------------|
| **Frontend / Extension** | React + TypeScript + CRXJS (Vite) |
| **Browser API Layer** | Chrome Extensions Manifest V3 |
| **Backend** | Django REST + Pathway streaming pipeline |
| **Communication** | Chrome Runtime Messaging API |
| **Styling** | Minimal grey/white theme (CSS) |

---

## Summary

**AEGIS** bridges client-side data observation and privacy-aware analytics.  
It captures contextual text and file data, preprocesses it locally, and securely communicates only essential metadata — all while maintaining user transparency and developer visibility.

> **AEGIS acts as a privacy guardian for user inputs** — combining real-time monitoring, secure encoding, and ethical data analytics in one cohesive ecosystem.
