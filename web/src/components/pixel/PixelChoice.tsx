import type { ChangeEventHandler, ComponentPropsWithoutRef, ReactNode } from "react";
import { MenuCursor } from "./MenuCursor";
import { PX, cx } from "./classes";

type Props = {
  type?: "radio" | "checkbox";
  name: string;
  value: string;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  className?: string;
  children: ReactNode;
  inputProps?: Omit<ComponentPropsWithoutRef<"input">, "type" | "name" | "value" | "checked" | "onChange" | "className">;
};

/**
 * A choice pill: a native sr-only radio (or checkbox) inside its label, so arrow keys, forms and
 * `input[name=…]:checked` queries keep working. Checked shows the fill, the ▶ cursor and the pressed look.
 */
export function PixelChoice({ type = "radio", name, value, checked, onChange, className, children, inputProps }: Props) {
  return (
    <label className={cx(PX.choice.skin, className ?? PX.choice.layout)}>
      <input type={type} className="sr-only" name={name} value={value} checked={checked} onChange={onChange} {...inputProps} />
      <MenuCursor className="hidden shrink-0 group-has-checked/choice:block" />
      {children}
    </label>
  );
}
