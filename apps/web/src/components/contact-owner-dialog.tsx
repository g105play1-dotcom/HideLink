'use client';

import {
  OWNER_CONTACT_MAX_LENGTH,
  OWNER_MESSAGE_MAX_LENGTH,
  OWNER_MESSAGE_TOPICS,
  type OwnerMessageTopic,
} from '@anonlink/shared';
import { LoaderCircle, Send } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/error-text';
import { apiRequest } from '@/lib/http';
import { OWNER_TOPIC_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

/**
 * "Contact the owner" — the one form through which a user writes to the operator.
 *
 * ## The wording is part of the feature
 *
 * A message sent here *is* stored, which is the opposite of a chat message, so the form
 * says so before sending: what is kept, that the owner can see the sender's User ID, and
 * that it is deleted automatically later. That is the difference between this and the
 * silent archive (docs/DECISIONS.md D21/D26) — the user is asked, not told afterwards.
 *
 * ## Why the sections and the free text
 *
 * The topic picks a subsection of the owner's inbox (жалобы, предложения, реклама,
 * сотрудничество, …) so it can be triaged, while the text stays free. The contact line is
 * optional and unvalidated: requiring an e-mail here would quietly turn an anonymous
 * service into one that collects contact details.
 */
export function ContactOwnerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const notify = useAppStore((state) => state.notify);

  const [topic, setTopic] = useState<OwnerMessageTopic>('suggestion');
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);

  const canSend = text.trim().length > 0 && !busy;

  async function submit() {
    if (!canSend) return;

    setBusy(true);
    try {
      await apiRequest('/owner/messages', {
        method: 'POST',
        json: {
          topic,
          text: text.trim(),
          ...(contact.trim() ? { contact: contact.trim() } : {}),
        },
      });

      setText('');
      setContact('');
      onClose();
      notify('success', 'Сообщение отправлено хозяину сервиса.');
    } catch (error) {
      // The text is kept on purpose: a failed send must not cost the user what they wrote.
      notify('error', describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="Связаться с хозяином сервиса"
      description="Выберите тему, чтобы сообщение попало по адресу."
      onClose={busy ? undefined : onClose}
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Тема обращения</legend>

          {OWNER_MESSAGE_TOPICS.map((value) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 text-sm transition-colors',
                topic === value ? 'border-primary bg-accent/50' : 'border-border hover:bg-muted',
              )}
            >
              <input
                type="radio"
                name="owner-topic"
                value={value}
                checked={topic === value}
                onChange={() => setTopic(value)}
                className="accent-(--primary)"
              />
              {OWNER_TOPIC_LABELS[value]}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium" htmlFor="owner-message-text">
            Текст сообщения
          </label>
          <Textarea
            id="owner-message-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            maxLength={OWNER_MESSAGE_MAX_LENGTH}
            placeholder="Опишите подробнее, чем помочь."
          />
          <p className="text-right text-xs text-muted-foreground">
            {text.length} / {OWNER_MESSAGE_MAX_LENGTH}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium" htmlFor="owner-message-contact">
            Как с вами связаться{' '}
            <span className="font-normal text-muted-foreground">(необязательно)</span>
          </label>
          <Input
            id="owner-message-contact"
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            maxLength={OWNER_CONTACT_MAX_LENGTH}
            placeholder="Ссылка, ник или адрес — если хотите ответ"
            autoComplete="off"
          />
        </div>

        <p className="text-xs text-muted-foreground">
          Сообщение сохраняется, чтобы хозяин сервиса мог его прочитать и ответить, и удаляется
          автоматически по истечении срока хранения. Ваш User ID видит только хозяин.
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={!canSend}>
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="size-4" aria-hidden="true" />
            )}
            Отправить хозяину
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
