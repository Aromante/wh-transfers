import React, { useEffect, useRef, useState } from 'react'

type Props = {
  onScan: (code: string) => void
}

export default function ScannerInput({ onScan }: Props) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
    const id = setInterval(() => ref.current?.focus(), 1500) // mantener foco
    return () => clearInterval(id)
  }, [])

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

