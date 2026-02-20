import React, { useEffect, useRef, useState } from 'react'

type Props = {
  onScan: (code: string) => void
  autoFocusEnabled?: boolean
}

export default function ScannerInput({ onScan, autoFocusEnabled = true }: Props) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!autoFocusEnabled) return
    ref.current?.focus()
    const id = setInterval(() => ref.current?.focus(), 6000) // mantener foco (cada 6s)
    return () => clearInterval(id)
  }, [autoFocusEnabled])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const code = value.trim()
      if (code) onScan(code)
      setValue('')
    }
  }

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Escanea o teclea código de barra y presiona Enter"
      style={{ width: '100%', padding: 12, border: '1px solid #e5e7eb', borderRadius: 6 }}
    />
  )
}
