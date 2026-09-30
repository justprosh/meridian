let holders = 0

export function retainBookkeepingRuntimeIdentity(): () => void {
  holders++
  let released = false
  return () => {
    if (!released) {
      released = true
      holders--
    }
  }
}

export function assertBookkeepingRuntimeIdentityChangeAllowed(): void {
  if (holders) throw new Error("cannot change session store directory while SQLite proxies are running")
}
