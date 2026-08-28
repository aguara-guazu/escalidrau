// Matches the library's tabler-style icon conventions so custom menu items
// render consistently with the default ones.
const iconProps = {
  "aria-hidden": true,
  focusable: false,
  role: "img",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
} as const;

export const importIcon = (
  <svg {...iconProps}>
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" />
    <path d="M12 3v13" />
    <path d="M8 12l4 4l4 -4" />
  </svg>
);

export const copyIcon = (
  <svg {...iconProps}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

export const trashIcon = (
  <svg {...iconProps}>
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" />
    <path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" />
  </svg>
);

export const chevronIcon = (
  <svg {...iconProps}>
    <path d="M9 6l6 6l-6 6" />
  </svg>
);

export const folderIcon = (
  <svg {...iconProps}>
    <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" />
  </svg>
);

export const libraryIcon = (
  <svg {...iconProps}>
    <path d="M5 4a2 2 0 0 1 2 -2h0a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h0a2 2 0 0 1 -2 -2z" />
    <path d="M9 4a2 2 0 0 1 2 -2h0a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h0a2 2 0 0 1 -2 -2z" />
    <path d="M5 8h4" />
    <path d="M9 16h4" />
    <path d="M13.803 4.56l2.184 -.53c.562 -.135 1.133 .19 1.282 .732l3.695 13.418a1.02 1.02 0 0 1 -.634 1.219l-.133 .041l-2.184 .53c-.562 .135 -1.133 -.19 -1.282 -.732l-3.695 -13.418a1.02 1.02 0 0 1 .634 -1.219l.133 -.041z" />
    <path d="M14 9l4 -1" />
    <path d="M16 16l3.923 -.98" />
  </svg>
);
