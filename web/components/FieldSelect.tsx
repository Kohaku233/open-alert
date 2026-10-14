import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
export function FieldSelect({ label, value, onValueChange, options, disabled = false, id }: {
  label: string; value: string; onValueChange: (value: string) => void;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean; id?: string;
}) {
  return <Select value={value} onValueChange={onValueChange} disabled={disabled}>
    <SelectTrigger id={id} aria-label={label} className="ui-field-select"><SelectValue /></SelectTrigger>
    <SelectContent className="ui-select-content" position="popper">
      {options.map(option => <SelectItem key={option.value} value={option.value} data-value={option.value} disabled={option.disabled ?? false}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
