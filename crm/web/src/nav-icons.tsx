export type NavigationIconName =
  | 'queue'
  | 'intake'
  | 'handbook'
  | 'portfolio'
  | 'reports'
  | 'exchange'
  | 'workflow'
  | 'users'
  | 'import'
  | 'activities'
  | 'feed'
  | 'notifications'
  | 'more';

export function NavigationIcon({ name }: { name: NavigationIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === 'queue' && <>
        <path d="M4 5.5h16v13H4z" />
        <path d="M4 13h4l2 3h4l2-3h4" />
      </>}
      {name === 'intake' && <>
        <path d="M12 3.5v10" />
        <path d="m8 9.5 4 4 4-4" />
        <path d="M5 15.5v4h14v-4" />
      </>}
      {name === 'handbook' && <>
        <path d="M12 6.5c-2-1.7-4.7-2.3-8-1.8v13c3.3-.5 6 0 8 1.8 2-1.8 4.7-2.3 8-1.8v-13c-3.3-.5-6 0-8 1.8Z" />
        <path d="M12 6.5v13" />
      </>}
      {name === 'portfolio' && <>
        <path d="M4 19.5v-6" />
        <path d="M10 19.5v-11" />
        <path d="M16 19.5v-9" />
        <path d="M22 19.5v-15" />
      </>}
      {name === 'reports' && <>
        <path d="M5 3.5h9l5 5v12H5z" />
        <path d="M14 3.5v5h5" />
        <path d="M8 16.5v-3M12 16.5v-5M16 16.5v-2" />
      </>}
      {name === 'exchange' && <>
        <path d="M4 8h15" />
        <path d="m15 4 4 4-4 4" />
        <path d="M20 16H5" />
        <path d="m9 12-4 4 4 4" />
      </>}
      {name === 'workflow' && <>
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="M8 6h8M7.2 7.7l3.6 8.5m6-8.5-3.6 8.5" />
      </>}
      {name === 'users' && <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 20v-1.5A5.5 5.5 0 0 1 9 13h0a5.5 5.5 0 0 1 5.5 5.5V20" />
        <path d="M16 5.3a3 3 0 0 1 0 5.4m1 2.5a5.4 5.4 0 0 1 3.5 5v1" />
      </>}
      {name === 'import' && <>
        <path d="M12 15V4" />
        <path d="m8 8 4-4 4 4" />
        <path d="M5 14.5v5h14v-5" />
      </>}
      {name === 'activities' && <>
        <path d="M5 5.5h14M5 12h14M5 18.5h14" />
        <circle cx="3" cy="5.5" r=".35" fill="currentColor" stroke="none" />
        <circle cx="3" cy="12" r=".35" fill="currentColor" stroke="none" />
        <circle cx="3" cy="18.5" r=".35" fill="currentColor" stroke="none" />
      </>}
      {name === 'feed' && <>
        <circle cx="5" cy="6" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="5" cy="18" r="1.5" />
        <path d="M9 6h11M9 12h11M9 18h11" />
      </>}
      {name === 'notifications' && <>
        <path d="M6 17h12l-1.5-2.5V10a4.5 4.5 0 0 0-9 0v4.5L6 17Z" />
        <path d="M10 20h4" />
      </>}
      {name === 'more' && <>
        <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
      </>}
    </svg>
  );
}
