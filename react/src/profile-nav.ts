/*
 * App-wide "open a user's profile" signal. Any user avatar/icon can call
 * openUserProfile(person); App listens for the event, switches to the profile
 * tab, and — when the person isn't the signed-in user — opens their read-only
 * profile panel. Mirrors the existing `open-journal-entry` event pattern.
 */
export interface ProfilePerson {
  id: string
  display_name: string
  color?: string
}

export const OPEN_USER_PROFILE_EVENT = 'open-user-profile'

export function openUserProfile(person: ProfilePerson) {
  if (!person.id) return
  window.dispatchEvent(new CustomEvent(OPEN_USER_PROFILE_EVENT, { detail: person }))
}
