interface LoadingOrbProps {
  label?: string
  compact?: boolean
  className?: string
}

const DOT_POSITIONS = [
  'left-1/2 top-1 -translate-x-1/2',
  'left-2 bottom-2',
  'right-2 bottom-2',
]

export default function LoadingOrb({
  label = 'Loading...',
  compact = false,
  className = '',
}: LoadingOrbProps) {
  const sizeClass = compact ? 'size-14' : 'size-28'
  const dotClass = compact ? 'size-1.5' : 'size-2.5'

  return (
    <div className={`flex flex-col items-center gap-3 ${className}`}>
      <div className={`relative ${sizeClass}`}>
        <div className="absolute inset-0 rounded-full border border-[#2a2a2a] bg-[#111]/80 shadow-[0_24px_70px_rgba(0,0,0,0.08)]" />
        <div className="absolute inset-2 rounded-full border border-dashed border-[#333] loading-orbit" />
        <div className="absolute inset-[28%] rounded-full bg-white shadow-[0_0_0_6px_rgba(255,255,255,0.08)] loading-bob" />
        <div className="absolute inset-0 loading-orbit">
          {DOT_POSITIONS.map((position, index) => (
            <span
              key={position}
              className={`absolute ${position} ${dotClass} rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,0.2)] loading-bob`}
              style={{ animationDelay: `${index * 180}ms` }}
            />
          ))}
        </div>
      </div>
      {label && (
        <p
          className={`text-center font-medium tracking-wide text-white/55 ${
            compact ? 'text-xs' : 'text-sm'
          }`}
        >
          {label}
        </p>
      )}
    </div>
  )
}
