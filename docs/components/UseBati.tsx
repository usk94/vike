export { UseBati }

import React from 'react'

function UseBati({ children }: { children: string | React.ReactElement }) {
  return (
    <p>
      You can use <Bati /> to scaffold a Vike app that uses {children}.
    </p>
  )
}

function Bati() {
  return <a href="https://batijs.dev/">Bati</a>
}
