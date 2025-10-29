import React from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import TransferPage from './pages/TransferPage'

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:bg-slate-900/60 dark:border-slate-800">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-semibold tracking-tight">Warehouse Transfers</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            <Link to="/">Inicio</Link>
          </div>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<TransferPage />} />
        <Route path="*" element={<div className="p-6">No encontrado</div>} />
      </Routes>
    </div>
  )
}
