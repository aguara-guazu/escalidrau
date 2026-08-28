import type { ReactNode } from "react";

// The editor's own welcome-screen arrows (MIT), so the hints match: the menu
// arrow (curving up, mirrored here to point up-right) and the toolbar arrow
// (curving straight up).
const menuArrow = (
  <svg viewBox="0 0 41 94" aria-hidden="true" focusable="false" className="esc-hint__arrow esc-hint__arrow--menu">
    <path
      d="M38.5 83.5c-14-2-17.833-10.473-21-22.5C14.333 48.984 12 22 12 12.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    />
    <path d="m12.005 10.478 7.905 14.423L6 25.75l6.005-15.273Z" fill="currentColor" />
  </svg>
);

const toolbarArrow = (
  <svg viewBox="0 0 38 78" aria-hidden="true" focusable="false" className="esc-hint__arrow esc-hint__arrow--toolbar">
    <path
      d="M1 77c14-2 31.833-11.973 35-24 3.167-12.016-6-35-9.5-43.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    />
    <path d="m24.165 1.093-2.132 16.309 13.27-4.258-11.138-12.05Z" fill="currentColor" />
  </svg>
);

type Props = {
  children: ReactNode;
  /**
   * "beside": label to the left of an arrow that curves up to the control
   * (the editor's menu hint, mirrored). "below": arrow straight up to the
   * control with the label underneath (the editor's toolbar hint).
   */
  variant: "beside" | "below";
};

/**
 * Welcome-screen hint for one of the app's own top-right controls, rendered
 * inside a `.esc-hint-anchor` wrapper around that control so it stays put
 * whatever the window width. Styled with the editor's own hint classes.
 */
export function WelcomeHint({ children, variant }: Props) {
  return (
    <div className={`esc-hint esc-hint--${variant} welcome-screen-decor excalifont`} role="note">
      {variant === "beside" ? (
        <>
          <div className="esc-hint__label">{children}</div>
          {menuArrow}
        </>
      ) : (
        <>
          {toolbarArrow}
          <div className="esc-hint__label">{children}</div>
        </>
      )}
    </div>
  );
}
