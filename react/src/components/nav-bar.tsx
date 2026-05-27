const today = new Date().getDate()

export type NavPanel = 'journal' | 'collab' | 'journey' | 'schedule' | 'profile'

export default function NavBar({
  panel,
  onSetPanel,
}: {
  panel: NavPanel
  onSetPanel: (p: NavPanel) => void
}) {
  const Btn = ({
    id,
    label,
    children,
  }: {
    id: NavPanel
    label: string
    children: React.ReactNode
  }) => {
    const active = panel === id
    return (
      <div
        role="button"
        onClick={() => onSetPanel(id)}
        className="flex-1 flex flex-col items-center gap-1 py-1 cursor-pointer"
      >
        <div style={{ opacity: active ? 1 : 0.35 }}>{children}</div>
        <span
          className="text-[10px] font-semibold tracking-wide"
          style={{ color: active ? '#fff' : 'rgba(255,255,255,.35)' }}
        >
          {label}
        </span>
      </div>
    )
  }

  return (
    <nav
      className="fixed bottom-3 left-4 right-4 h-[72px] flex items-end justify-between px-2 pb-2.5 z-[100] backdrop-blur-24"
      style={{
        background: 'rgba(10,10,10,.78)',
        border: '1px solid rgba(255,255,255,.08)',
        borderRadius: 26,
      }}
    >
      <Btn id="journal" label="Journal">
        <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor">
          <path d="M5 10.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5" />
          <path d="M3 0h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-1h1v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1H1V2a2 2 0 0 1 2-2" />
          <path d="M1 5v-.5a.5.5 0 0 1 1 0V5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0V8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0v.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1z" />
        </svg>
      </Btn>

      <Btn id="collab" label="Collab">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </Btn>

      <Btn id="journey" label="Journey">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M10.5766 8.20419C11.2099 7.06806 11.5266 6.5 12 6.5C12.4734 6.5 12.7901 7.06806 13.4234 8.20419L13.5873 8.49812C13.7672 8.82097 13.8572 8.98239 13.9975 9.0889C14.1378 9.19541 14.3126 9.23495 14.6621 9.31402L14.9802 9.38601C16.2101 9.66428 16.825 9.80341 16.9713 10.2739C17.1176 10.7443 16.6984 11.2345 15.86 12.215L15.643 12.4686C15.4048 12.7472 15.2857 12.8865 15.2321 13.0589C15.1785 13.2312 15.1965 13.4171 15.2325 13.7888L15.2653 14.1272C15.3921 15.4353 15.4554 16.0894 15.0724 16.3801C14.6894 16.6709 14.1137 16.4058 12.9622 15.8756L12.6643 15.7384C12.337 15.5878 12.1734 15.5124 12 15.5124C11.8266 15.5124 11.663 15.5878 11.3357 15.7384L11.0378 15.8756C9.88634 16.4058 9.31059 16.6709 8.92757 16.3801C8.54456 16.0894 8.60794 15.4353 8.7347 14.1272L8.76749 13.7888C8.80351 13.4171 8.82152 13.2312 8.76793 13.0589C8.71434 12.8865 8.59521 12.7472 8.35696 12.4686L8.14005 12.215C7.30162 11.2345 6.88241 10.7443 7.02871 10.2739C7.17501 9.80341 7.78993 9.66428 9.01977 9.38601L9.33794 9.31402C9.68743 9.23495 9.86217 9.19541 10.0025 9.0889C10.1428 8.98239 10.2328 8.82097 10.4127 8.49812L10.5766 8.20419Z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      </Btn>

      <Btn id="schedule" label="Schedule">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2.5" />
          <line x1="3" y1="10" x2="21" y2="10" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <text x="12" y="17.5" textAnchor="middle" dominantBaseline="middle" fontSize="6.5" fontWeight="800" fill="currentColor" stroke="none" fontFamily="system-ui,-apple-system,sans-serif">
            {today}
          </text>
        </svg>
      </Btn>

      <Btn id="profile" label="Profile">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </Btn>
    </nav>
  )
}
