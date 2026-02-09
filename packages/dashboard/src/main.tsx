import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@webtui/css'
import '@webtui/theme-catppuccin'
import './styles/app.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
