import { cx, Icon, type IconName } from "@tearleads/ui/react";
import {
  setThemePreference,
  type ThemePreference,
  useThemePreference,
} from "./theme";

const options: { icon: IconName; label: string; value: ThemePreference }[] = [
  { icon: "monitor", label: "System", value: "system" },
  { icon: "sun", label: "Light", value: "light" },
  { icon: "moon", label: "Dark", value: "dark" },
];

/**
 * System, Light, and Dark options for this device. Inside a menu the options
 * are menu radio items labelled by the menu's own heading; elsewhere they are
 * toggle buttons.
 */
export function ThemeSwitcher({
  className,
  labelledBy,
  menu = false,
}: {
  className?: string;
  labelledBy?: string;
  menu?: boolean;
}) {
  const preference = useThemePreference();
  return (
    <fieldset
      aria-labelledby={labelledBy}
      className={cx("segmented", menu && "segmentedFill", className)}
    >
      {!labelledBy && <legend className="srOnly">Theme</legend>}
      {options.map(({ icon, label, value }) => {
        const selected = value === preference;
        const select = () => setThemePreference(value);
        const content = (
          <>
            <Icon name={icon} size={16} />
            {label}
          </>
        );
        return menu ? (
          <button
            aria-checked={selected}
            key={value}
            onClick={select}
            role="menuitemradio"
            type="button"
          >
            {content}
          </button>
        ) : (
          <button
            aria-pressed={selected}
            key={value}
            onClick={select}
            type="button"
          >
            {content}
          </button>
        );
      })}
    </fieldset>
  );
}
