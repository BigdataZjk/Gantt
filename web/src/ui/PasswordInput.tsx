import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import styles from "./PasswordInput.module.css";

export interface PasswordInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  labelText?: string;
}

export function PasswordInput({ id, value, onChange, onVisibilityChange, placeholder, autoComplete, required, disabled, readOnly, ariaLabel, labelText = "密码" }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={styles.wrap}>
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className={styles.eye}
        aria-label={visible ? `隐藏${labelText}` : `显示${labelText}`}
        aria-pressed={visible}
        data-tooltip={visible ? "隐藏密码" : "显示密码"}
        disabled={disabled}
        onClick={() => {
          const nextVisible = !visible;
          setVisible(nextVisible);
          onVisibilityChange?.(nextVisible);
        }}
      >
        {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </div>
  );
}
