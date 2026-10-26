'use client';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { CaseDraft, FactValue, Medications } from '../../../packages/contracts/src/index';
import { errorText, patch } from './api';

type Pending = { facts?: Record<string, FactValue>; medications?: Medications };
const schema = z.object({
  facts: z
    .record(
      z.string(),
      z.object({
        state: z.enum(['KNOWN', 'UNKNOWN', 'NOT_ASSESSED']),
        value: z.union([z.boolean(), z.number(), z.string(), z.null()]),
        unit: z.string().nullable().optional(),
      }),
    )
    .optional(),
  medications: z
    .object({
      state: z.enum(['UNKNOWN', 'KNOWN_NONE', 'KNOWN_LIST']),
      drug_ids: z.array(z.number().int().positive()),
      unrecognized: z.array(z.string()),
    })
    .optional(),
});
const hasChanges = (p: Pending) => !!Object.keys(p.facts || {}).length || !!p.medications;
const merge = (a: Pending, b: Pending): Pending => ({ ...a, ...b, facts: { ...a.facts, ...b.facts } });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const validMedications = (m: Medications) =>
  m.state !== 'KNOWN_LIST' || !!(m.drug_ids.length + m.unrecognized.length);

/** Each request contains only committed fields. Newer edits survive an older response. */
export function useCaseDraft(id: string, userId: string, onSaved: (draft: CaseDraft) => void) {
  const key = `medcalc:draft:${userId}:${id}`;
  const [pending, setPending] = useState<Pending>({});
  const [restored, setRestored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const data = useRef<Pending>({});
  const queued = useRef<Pending>({});
  const inFlight = useRef(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  function persist(next: Pending) {
    data.current = next;
    setPending(next);
    try {
      if (hasChanges(next)) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
    } catch {
      /* The server remains available when browser storage is disabled. */
    }
  }
  useEffect(() => {
    generation.current++;
    queued.current = {};
    inFlight.current = false;
    setSaving(false);
    setError('');
    let initial: Pending = {};
    try {
      const stored = localStorage.getItem(key);
      const parsed = stored ? schema.safeParse(JSON.parse(stored)) : undefined;
      if (parsed?.success) initial = parsed.data;
    } catch {
      /* Ignore invalid local drafts. */
    }
    data.current = initial;
    setPending(initial);
    setRestored(true);
    return () => {
      generation.current++;
      clearTimeout(timer.current);
    };
  }, [key]);

  async function flush() {
    if (inFlight.current || !hasChanges(queued.current)) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    const epoch = generation.current;
    try {
      while (hasChanges(queued.current)) {
        const sent = queued.current;
        queued.current = {};
        try {
          const result = await patch<CaseDraft>(`/cases/${id}`, sent);
          if (epoch !== generation.current) return;
          const remaining = { ...data.current, facts: { ...data.current.facts } };
          for (const [code, value] of Object.entries(sent.facts || {})) {
            if (equal(remaining.facts[code], value)) delete remaining.facts[code];
          }
          if (sent.medications && equal(remaining.medications, sent.medications))
            delete remaining.medications;
          persist(remaining);
          onSavedRef.current(result);
        } catch (e) {
          if (epoch !== generation.current) return;
          // Retry explicitly. Never enqueue uncommitted text on a network failure.
          queued.current = {};
          setError(errorText(e));
          break;
        }
      }
    } finally {
      if (epoch === generation.current) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  }
  function schedule() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 150);
  }
  function fact(code: string, value: FactValue, commit: boolean) {
    persist(merge(data.current, { facts: { [code]: value } }));
    const next = { ...queued.current, facts: { ...queued.current.facts } };
    delete next.facts[code];
    if (commit) next.facts[code] = value;
    queued.current = next;
    if (commit) schedule();
  }
  function commitFact(code: string) {
    const value = data.current.facts?.[code];
    if (value) {
      queued.current = merge(queued.current, { facts: { [code]: value } });
      schedule();
    }
  }
  function medications(value: Medications) {
    persist({ ...data.current, medications: value });
    delete queued.current.medications;
    if (validMedications(value)) {
      queued.current.medications = value;
      schedule();
    }
  }
  function retry() {
    // Native validity is checked by the owning form before this is called.
    queued.current = { ...data.current };
    if (queued.current.medications && !validMedications(queued.current.medications)) {
      delete queued.current.medications;
      setError('Добавьте препарат либо выберите «Не принимает» или «Неизвестно».');
    }
    void flush();
  }
  return {
    pending,
    restored,
    saving,
    error,
    dirty: hasChanges(pending),
    fact,
    commitFact,
    medications,
    retry,
  };
}
