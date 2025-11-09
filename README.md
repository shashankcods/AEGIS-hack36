<h1 align="center">AEGIS — Secure Prompting Practices</h1>
<p align="center">
A privacy-first browser extension designed to monitor, analyze, and securely process text and file inputs in real time — ensuring privacy-preserving AI interactions.
</p>

[![Built at Hack36](https://raw.githubusercontent.com/nihal2908/Hack-36-Readme-Template/main/BUILT-AT-Hack36-9-Secure.png)](https://raw.githubusercontent.com/nihal2908/Hack-36-Readme-Template/main/BUILT-AT-Hack36-9-Secure.png)

---

## Introduction:
**AEGIS** is a privacy-aware browser extension that captures, analyzes, and securely transmits text and file inputs from web environments for intelligent sensitivity detection.  
It integrates with a **Django + Pathway + Redis** backend to perform **real-time content analysis**, identifying personally identifiable information (PII), evaluating sensitivity scores, and maintaining privacy-first data handling.  

The system operates as a **CRXJS + React + TypeScript** extension, observing user input in browser environments and providing detailed visual insights through a clean popup UI.

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
- All data capture and preprocessing occur locally within the browser sandbox.  
- Only sanitized and encoded metadata is transmitted.  
- Fully adheres to **privacy-by-design** principles.

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
- **Pathway pipeline:** performs live sensitivity scoring and event aggregation.  
- **Django backend:** handles data storage, REST APIs, and visualization endpoints.  
- **Redis bridge:** connects Django and Pathway for real-time, low-latency data exchange.

---

### 5. Robust Data Logging  
- Each capture event includes:
  - Source (manual, automatic, paste, upload)
  - Associated metadata  
- Ensures reliable communication between:
  - **Content Script → Background Script → Backend**

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

**Team Name:** Level_Sabke_Niklenge  

- [Shashank Lakkarsu](https://github.com/shashankcods)  
- [Harish Raju](https://github.com/kyrolxg)  
- [Shabbeer Mohammed](https://github.com/shabbeer2513)  
- [Mogith Pushparaj](https://github.com/MogithX11)

---

## Made at:
[![Built at Hack36](https://raw.githubusercontent.com/nihal2908/Hack-36-Readme-Template/main/BUILT-AT-Hack36-9-Secure.png)](https://raw.githubusercontent.com/nihal2908/Hack-36-Readme-Template/main/BUILT-AT-Hack36-9-Secure.png)

