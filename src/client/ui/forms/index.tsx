import { useState, type FieldsetHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import styles from "./Forms.module.css";

type FieldBase = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly className?: string;
};

type NativeFieldProps = Readonly<{
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}>;

export function Field({ id, label, description, error, required, className, children }: FieldBase & {
  readonly children: (props: NativeFieldProps) => ReactNode;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return <div className={join(styles.field, className)}>
    <label htmlFor={id}>{label}{required ? <span className={styles.required} aria-hidden="true"> *</span> : null}</label>
    {description ? <p id={descriptionId} className={styles.description}>{description}</p> : null}
    {children({ "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
    {error ? <p id={errorId} className={styles.error}>{error}</p> : null}
  </div>;
}

type TextInputProps = FieldBase & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "required">;

export function TextInput({ id, label, description, error, required, className, ...props }: TextInputProps) {
  return <Field {...{ id, label, description, error, required, className }}>{(aria) =>
    <input {...props} {...aria} id={id} required={required} className={styles.control} />}</Field>;
}

export function PasswordInput({ id, label, description, error, required, className, ...props }: TextInputProps) {
  const [visible, setVisible] = useState(false);
  return <Field {...{ id, label, description, error, required, className }}>{(aria) =>
    <div className={styles.passwordControl}>
      <input {...props} {...aria} id={id} required={required} type={visible ? "text" : "password"} className={styles.control} />
      <button type="button" aria-label={visible ? "隐藏输入内容" : "显示输入内容"}
        title={`${visible ? "隐藏" : "显示"}${label}`} aria-pressed={visible}
        onClick={() => setVisible((value) => !value)}>{visible ? "隐藏" : "显示"}</button>
    </div>}</Field>;
}

type TextAreaProps = FieldBase & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "required">;

export function TextArea({ id, label, description, error, required, className, ...props }: TextAreaProps) {
  return <Field {...{ id, label, description, error, required, className }}>{(aria) =>
    <textarea {...props} {...aria} id={id} required={required} className={styles.control} />}</Field>;
}

type SelectProps = FieldBase & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "required"> & {
  readonly options: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[];
};

export function Select({ id, label, description, error, required, className, options, ...props }: SelectProps) {
  return <Field {...{ id, label, description, error, required, className }}>{(aria) =>
    <select {...props} {...aria} id={id} required={required} className={styles.control}>
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>}</Field>;
}

export function NumberInput(props: Omit<TextInputProps, "type">) {
  return <TextInput {...props} type="number" />;
}

type ChoiceProps = FieldBase & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type" | "required">;

export function Checkbox({ id, label, description, error, required, className, ...props }: ChoiceProps) {
  const describedBy = [description ? `${id}-description` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return <div className={join(styles.choiceField, className)}>
    <label htmlFor={id} className={styles.choice}>
      <input {...props} id={id} type="checkbox" required={required} aria-describedby={describedBy} aria-invalid={error ? true : undefined} />
      <span>{label}{required ? <span className={styles.required} aria-hidden="true"> *</span> : null}</span>
    </label>
    {description ? <p id={`${id}-description`} className={styles.description}>{description}</p> : null}
    {error ? <p id={`${id}-error`} className={styles.error}>{error}</p> : null}
  </div>;
}

export function Switch({ id, label, ...props }: ChoiceProps) {
  return <Checkbox {...props} id={id} label={label} role="switch" className={join(styles.switchField, props.className)} />;
}

export function CheckboxGroup({ legend, description, error, children, className, ...props }:
  FieldsetHTMLAttributes<HTMLFieldSetElement> & {
    readonly legend: string;
    readonly description?: string;
    readonly error?: string;
  }) {
  return <fieldset {...props} className={join(styles.choiceGroup, className)}>
    <legend>{legend}</legend>
    {description ? <p className={styles.description}>{description}</p> : null}
    <div className={styles.choiceGroupItems}>{children}</div>
    {error ? <p className={styles.error}>{error}</p> : null}
  </fieldset>;
}

export function RadioGroup({ legend, name, options, value, defaultValue, onChange, description, error, disabled }:
  {
    readonly legend: string;
    readonly name: string;
    readonly options: readonly { readonly value: string; readonly label: string; readonly description?: string }[];
    readonly value?: string;
    readonly defaultValue?: string;
    readonly onChange?: (value: string) => void;
    readonly description?: string;
    readonly error?: string;
    readonly disabled?: boolean;
  }) {
  return <fieldset className={styles.choiceGroup} disabled={disabled}>
    <legend>{legend}</legend>
    {description ? <p className={styles.description}>{description}</p> : null}
    <div className={styles.radioGrid}>{options.map((option) => {
      const id = `${name}-${option.value}`;
      const labelId = `${id}-label`;
      const descriptionId = option.description ? `${id}-description` : undefined;
      return <label key={option.value} htmlFor={id} className={styles.radioChoice}>
        <input id={id} name={name} type="radio" value={option.value} checked={value === undefined ? undefined : value === option.value}
          defaultChecked={value === undefined ? defaultValue === option.value : undefined}
          aria-labelledby={labelId} aria-describedby={descriptionId}
          onChange={() => onChange?.(option.value)} />
        <span><strong id={labelId}>{option.label}</strong>{option.description ?
          <small id={descriptionId}>{option.description}</small> : null}</span>
      </label>;
    })}</div>
    {error ? <p className={styles.error}>{error}</p> : null}
  </fieldset>;
}

export function FileDropzone({ id, label, description, error, required, className, ...props }:
  FieldBase & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type" | "required">) {
  return <Field {...{ id, label, description, error, required, className }}>{(aria) =>
    <label className={styles.dropzone} htmlFor={id}>
      <span>选择文件或拖放到此处</span>
      <input {...props} {...aria} id={id} type="file" required={required} />
    </label>}</Field>;
}

export function FormActions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={join(styles.formActions, className)} />;
}

function join(...values: readonly (string | undefined)[]) {
  return values.filter(Boolean).join(" ");
}
