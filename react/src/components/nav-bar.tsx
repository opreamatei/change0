const today = new Date().getDate()

export type NavPanel = 'journal' | 'collab' | 'journey' | 'schedule' | 'profile'

export default function NavBar({
  panel,
  onSetPanel,
}: {
  panel: NavPanel
  onSetPanel: (p: NavPanel) => void
}) {
  const cur = panel

  const Btn = ({
    page,
    label,
    children,
  }: {
    page: NavPanel
    label: string
    children: React.ReactNode
  }) => {
    const active = cur === page
    return (
      <div
        role="button"
        aria-label={label}
        title={label}
        onClick={() => onSetPanel(page)}
        className="flex-1 flex flex-col items-center gap-1 py-1 cursor-pointer transition-opacity"
      >
        <div className={`transition-opacity ${active ? 'opacity-100' : 'opacity-[.35]'}`}>{children}</div>
        <span
          className="text-[10px] font-semibold tracking-wide transition-colors"
          style={{ color: active ? '#fff' : 'rgba(255,255,255,.35)' }}
        >
          {label}
        </span>
      </div>
    )
  }

  return (
    <nav
      className="fixed bottom-3 left-4 right-4 h-[72px] flex items-end justify-between px-2 pb-2.5 z-[100]"
      style={{
        background: 'rgba(15,15,15,.97)',
        border: '1px solid rgba(255,255,255,.08)',
        borderRadius: 26,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
      }}
    >
      <Btn page="journal" label="Journal">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 10.4V20M12 10.4C12 8.15979 12 7.03969 11.564 6.18404C11.1805 5.43139 10.5686 4.81947 9.81596 4.43597C8.96031 4 7.84021 4 5.6 4H4.6C4.03995 4 3.75992 4 3.54601 4.10899C3.35785 4.20487 3.20487 4.35785 3.10899 4.54601C3 4.75992 3 5.03995 3 5.6V16.4C3 16.9601 3 17.2401 3.10899 17.454C3.20487 17.6422 3.35785 17.7951 3.54601 17.891C3.75992 18 4.03995 18 4.6 18H7.54668C8.08687 18 8.35696 18 8.61814 18.0466C8.84995 18.0879 9.0761 18.1563 9.29191 18.2506C9.53504 18.3567 9.75977 18.5065 10.2092 18.8062L12 20M12 10.4C12 8.15979 12 7.03969 12.436 6.18404C12.8195 5.43139 13.4314 4.81947 14.184 4.43597C15.0397 4 16.1598 4 18.4 4H19.4C19.9601 4 20.2401 4 20.454 4.10899C20.6422 4.20487 20.7951 4.35785 20.891 4.54601C21 4.75992 21 5.03995 21 5.6V16.4C21 16.9601 21 17.2401 20.891 17.454C20.7951 17.6422 20.6422 17.7951 20.454 17.891C20.2401 18 19.9601 18 19.4 18H16.4533C15.9131 18 15.643 18 15.3819 18.0466C15.15 18.0879 14.9239 18.1563 14.7081 18.2506C14.465 18.3567 14.2402 18.5065 13.7908 18.8062L12 20" />
        </svg>
      </Btn>

      <Btn page="collab" label="Collab">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </Btn>

      <Btn page="journey" label="Journey">
        {cur === 'journey' ? (
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: '9px' }}>
            <path d="M10.5766 8.70419C11.2099 7.56806 11.5266 7 12 7C12.4734 7 12.7901 7.56806 13.4234 8.70419L13.5873 8.99812C13.7672 9.32097 13.8572 9.48239 13.9975 9.5889C14.1378 9.69541 14.3126 9.73495 14.6621 9.81402L14.9802 9.88601C16.2101 10.1643 16.825 10.3034 16.9713 10.7739C17.1176 11.2443 16.6984 11.7345 15.86 12.715L15.643 12.9686C15.4048 13.2472 15.2857 13.3865 15.2321 13.5589C15.1785 13.7312 15.1965 13.9171 15.2325 14.2888L15.2653 14.6272C15.3921 15.9353 15.4554 16.5894 15.0724 16.8801C14.6894 17.1709 14.1137 16.9058 12.9622 16.3756L12.6643 16.2384C12.337 16.0878 12.1734 16.0124 12 16.0124C11.8266 16.0124 11.663 16.0878 11.3357 16.2384L11.0378 16.3756C9.88634 16.9058 9.31059 17.1709 8.92757 16.8801C8.54456 16.5894 8.60794 15.9353 8.7347 14.6272L8.76749 14.2888C8.80351 13.9171 8.82152 13.7312 8.76793 13.5589C8.71434 13.3865 8.59521 13.2472 8.35696 12.9686L8.14005 12.715C7.30162 11.7345 6.88241 11.2443 7.02871 10.7739C7.17501 10.3034 7.78993 10.1643 9.01977 9.88601L9.33794 9.81402C9.68743 9.73495 9.86217 9.69541 10.0025 9.5889C10.1428 9.48239 10.2328 9.32097 10.4127 8.99812L10.5766 8.70419Z" />
            <path d="M12 2V4" /><path d="M12 20V22" /><path d="M2 12L4 12" /><path d="M20 12L22 12" />
            <path d="M6 18L6.34305 17.657" /><path d="M17.6567 6.34326L18 6" /><path d="M18 18L17.657 17.657" /><path d="M6.34326 6.34326L6 6" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: '9px' }}>
            <path fillRule="evenodd" clipRule="evenodd" d="M10.1631 2.7372C10.8572 1.12528 13.1427 1.12528 13.8369 2.7372L15.4229 6.42011C15.5677 6.75629 15.8846 6.98651 16.249 7.02031L20.2418 7.39063C21.9893 7.55271 22.6956 9.72633 21.377 10.8846L18.3645 13.5311C18.0895 13.7727 17.9685 14.1452 18.049 14.5023L18.9306 18.414C19.3165 20.1261 17.4675 21.4695 15.9584 20.5734L12.5105 18.5262C12.1958 18.3393 11.8041 18.3393 11.4894 18.5262L8.04154 20.5734C6.53248 21.4695 4.68348 20.1261 5.06936 18.414L5.95099 14.5023C6.03147 14.1452 5.91044 13.7727 5.63545 13.5311L2.62291 10.8846C1.30438 9.72633 2.01063 7.55271 3.75818 7.39063L7.75094 7.02031C8.1154 6.98651 8.43227 6.75629 8.57704 6.42011L10.1631 2.7372ZM13.586 7.21117L12 3.52826L10.4139 7.21117C9.97963 8.21969 9.02902 8.91036 7.93564 9.01176L3.94288 9.38208L6.95542 12.0286C7.78038 12.7533 8.14348 13.8708 7.90205 14.942L7.02042 18.8538L10.4683 16.8065C11.4125 16.2458 12.5875 16.2458 13.5317 16.8065L16.9795 18.8538L16.0979 14.942C15.8565 13.8708 16.2196 12.7533 17.0445 12.0286L20.0571 9.38208L16.0643 9.01176C14.9709 8.91036 14.0203 8.21969 13.586 7.21117Z" />
          </svg>
        )}
      </Btn>

      <Btn page="schedule" label="Schedule">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2.5" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <text x="12" y="14.5" textAnchor="middle" dominantBaseline="middle" fontSize="9" fontWeight="400" fill="currentColor" stroke="none" fontFamily="system-ui,-apple-system,sans-serif">
            {today}
          </text>
        </svg>
      </Btn>

      <Btn page="profile" label="Profile">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </Btn>
    </nav>
  )
}
