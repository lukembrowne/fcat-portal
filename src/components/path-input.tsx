"use client";

import { useState, forwardRef, type InputHTMLAttributes } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface PathInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  label?: string;
  error?: string;
  helperText?: string;
  value?: string;
  onChange?: (value: string) => void;
}

export const PathInput = forwardRef<HTMLInputElement, PathInputProps>(
  (
    {
      label,
      error,
      helperText,
      onChange,
      value: controlledValue,
      className,
      placeholder = "/ruta/a/imagenes",
      ...props
    },
    ref
  ) => {
    const [internalValue, setInternalValue] = useState(
      props.defaultValue?.toString() || ""
    );

    const value = controlledValue !== undefined ? controlledValue : internalValue;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setInternalValue(newValue);
      onChange?.(newValue);
    };

    return (
      <div className="space-y-2">
        {label && (
          <Label
            htmlFor={props.id || props.name}
            className={cn(error && "text-destructive")}
          >
            {label}
          </Label>
        )}

        <Input
          ref={ref}
          type="text"
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          className={cn(
            "font-mono text-sm",
            error && "border-destructive focus-visible:ring-destructive",
            className
          )}
          {...props}
        />

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {helperText && !error && (
          <p className="text-sm text-muted-foreground">{helperText}</p>
        )}
      </div>
    );
  }
);

PathInput.displayName = "PathInput";
