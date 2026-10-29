import { PX, cx } from "./classes";

type Props = {
  className?: "text-balance";
  /** On the fixed game screen, which stays light in dark mode (guide 1.3) */
  onScreen?: boolean;
  id?: string;
  /** -1 so a later script can move focus here (TG-46 PR B), never a Tab stop */
  tabIndex?: number;
  children: string;
};

/** The page h1 in the pixel font. Static text only: the font has no ₱ or →. className may add text-balance. */
export function PageTitle({ className, onScreen, id, tabIndex, children }: Props) {
  return (
    <h1 id={id} tabIndex={tabIndex} className={cx(onScreen ? PX.h1Screen : PX.h1, className)}>
      {children}
    </h1>
  );
}
