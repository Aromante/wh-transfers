import React from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import TransferPage from './pages/TransferPage'
import ReceivePage from './pages/ReceivePage'
import HistoryPage from './pages/HistoryPage'

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  const { pathname } = useLocation()
  const active = pathname === to
  return (
    <Link
      to={to}
      className={active
        ? 'font-medium text-slate-900'
        : 'text-slate-500 hover:text-slate-800'}
    >
      {children}
    </Link>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:bg-slate-900/60 dark:border-slate-800">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-semibold tracking-tight">Warehouse Transfers</span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <NavLink to="/">Envío</NavLink>
            <span className="text-slate-200">/</span>
            <NavLink to="/receive">Recepción</NavLink>
            <span className="text-slate-200">/</span>
            <NavLink to="/history">Historial</NavLink>
          </div>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<TransferPage />} />
        <Route path="/receive" element={<ReceivePage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="*" element={<div className="p-6">No encontrado</div>} />
      </Routes>
    </div>
  )
}
