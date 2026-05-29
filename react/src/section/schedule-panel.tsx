import { useState } from 'react'
import DailyBriefView from './daily-brief-view'
import RemindersView from './reminders-view'

/**
 * Schedule panel — mirrors ui-2's SchedulePage where reminders live as a tab
 * inside the schedule section rather than a separate nav destination.
 */
export default function SchedulePanel() {
  const [view, setView] = useState<'schedule' | 'reminders'>('schedule')

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 px-6 pt-[52px] pb-2">
        <div
          className="flex gap-[2px] p-[3px]"
          style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 14 }}
        >
          {(['schedule', 'reminders'] as const).map((v) => (
            <div
              key={v}
              onClick={() => setView(v)}
              className="flex-1 cursor-pointer rounded-[11px] py-2 text-center text-xs font-semibold transition-all"
              style={{ background: view === v ? '#fff' : 'transparent', color: view === v ? '#000' : 'var(--white-dim)' }}
            >
              {v === 'schedule' ? 'Schedule' : 'Reminders'}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {view === 'schedule' ? (
          <DailyBriefView embedded />
        ) : (
          <div className="h-full overflow-y-auto no-scrollbar px-5 pt-3 pb-28">
            <RemindersView embedded />
          </div>
        )}
      </div>
    </div>
  )
}
