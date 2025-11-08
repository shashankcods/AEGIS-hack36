// extension/src/popup/main.tsx
import { createRoot } from 'react-dom/client';
import Popup from './Popup';
import './popup.css';

const root = document.getElementById('root')!;
createRoot(root).render(<Popup />);
