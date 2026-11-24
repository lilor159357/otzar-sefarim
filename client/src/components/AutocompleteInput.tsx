import React, { useState, useEffect, useRef } from 'react';
import { Loader2, RotateCcw, Check } from 'lucide-react';

interface SuggestionItem {
  value: string;
  count: number;
}

interface AutocompleteInputProps {
  label?: string;
  value: string;
  onChange: (val: string) => void;
  field: 'author' | 'set_name' | 'publisher' | 'category' | string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  required?: boolean;
  disabled?: boolean;
  badgeText?: string;
  onRestoreRaw?: () => void;
  rawRestorableValue?: string;
}

export const AutocompleteInput: React.FC<AutocompleteInputProps> = ({
  label,
  value,
  onChange,
  field,
  placeholder,
  className = '',
  inputClassName = '',
  required = false,
  disabled = false,
  badgeText,
  onRestoreRaw,
  rawRestorableValue,
}) => {
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchSuggestions = (query: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    debounceTimerRef.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        const res = await fetch(
          `/api/catalog/suggestions?field=${encodeURIComponent(field)}&q=${encodeURIComponent(query.trim())}`
        );
        if (res.ok) {
          const raw = await res.json();
          const list: SuggestionItem[] = Array.isArray(raw) ? raw : Array.isArray(raw?.suggestions) ? raw.suggestions : [];
          setSuggestions(list);
          if (list.length > 0) {
            setIsOpen(true);
          }
        }
      } catch (err) {
        // silent fail on network error
      } finally {
        setIsLoading(false);
      }
    }, 180);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onChange(val);
    setHighlightIndex(-1);
    fetchSuggestions(val);
  };

  const handleFocus = () => {
    fetchSuggestions(value);
  };

  const handleSelect = (itemValue: string) => {
    onChange(itemValue);
    setIsOpen(false);
    setSuggestions([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || suggestions.length === 0) {
      if (e.key === 'ArrowDown') {
        fetchSuggestions(value);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
    } else if (e.key === 'Enter') {
      if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
        e.preventDefault();
        handleSelect(suggestions[highlightIndex].value);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}`} dir="rtl">
      {label && (
        <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
      )}

      <div className="relative flex items-center">
        <input
          type="text"
          value={value}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          autoComplete="off"
          className={`w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 transition-colors ${
            isLoading ? 'pe-8' : ''
          } ${inputClassName}`}
        />
        {isLoading && (
          <div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          </div>
        )}
      </div>

      {badgeText && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200/60 dark:border-amber-800/40 px-2 py-0.5 rounded-md">
          <Check className="w-3 h-3 text-amber-600 shrink-0" />
          <span className="truncate">{badgeText}</span>
          {onRestoreRaw && rawRestorableValue && (
            <button
              type="button"
              onClick={onRestoreRaw}
              title={`שחזר לשם המקורי: "${rawRestorableValue}"`}
              className="ms-auto shrink-0 flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline font-medium"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              שחזר למקורי
            </button>
          )}
        </div>
      )}

      {isOpen && suggestions.length > 0 && (
        <ul className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl max-h-56 overflow-y-auto text-sm divide-y divide-slate-100 dark:divide-slate-700/50">
          {suggestions.map((item, idx) => {
            const isSelected = item.value === value;
            const isHighlighted = idx === highlightIndex;
            return (
              <li
                key={`${item.value}-${idx}`}
                onClick={() => handleSelect(item.value)}
                onMouseEnter={() => setHighlightIndex(idx)}
                className={`px-3 py-2 cursor-pointer flex items-center justify-between transition-colors ${
                  isHighlighted
                    ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-950 dark:text-amber-100'
                    : isSelected
                    ? 'bg-slate-50 dark:bg-slate-700/50 font-medium'
                    : 'text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700'
                }`}
              >
                <span className="truncate">{item.value}</span>
                <span className="shrink-0 ms-2 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-mono">
                  {item.count}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
