import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ServerStatus from './components/server-status.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ServerStatus />
  </StrictMode>,
)
