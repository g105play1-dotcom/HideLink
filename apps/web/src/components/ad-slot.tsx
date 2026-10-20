import { cn } from '@/lib/utils';

/**
 * Reserved advertising surfaces.
 *
 * AnonLink serves no advertising today and loads no third-party code. These slots exist
 * because the owner asked for the layout to be *ready* for it: the empty columns beside
 * the page, the space under the folded settings and the layer behind a conversation are
 * now real, sized containers, so adding a creative later is a change of content rather
 * than a change of layout (docs/DECISIONS.md D23/D28).
 *
 * ## Rules a creative must satisfy
 *
 *  - **Readability first.** Every message is drawn on its own opaque bubble, and the
 *    conversation's header and composer are opaque bars, so a creative can only show in
 *    the gaps between bubbles — never behind a word the user has to read. (The transcript
 *    container itself is deliberately transparent for this reason.)
 *  - **Nothing renders when empty.** An empty bordered box reads as a broken image, which
 *    is worse than no box at all, so an unfilled slot paints nothing.
 *  - **Hidden from assistive technology.** An empty container is noise: it would be
 *    announced (or, worse, a future creative would be read out unlabelled) with no
 *    relationship to the task the user came for. `aria-hidden` is deliberate; a real
 *    creative that must be perceivable would need its own decision.
 *  - **No third-party scripts without a decision.** Tracking a reader of an anonymous chat
 *    is a privacy change, not an implementation detail: it belongs in `docs/SECURITY.md`
 *    and `docs/DECISIONS.md` before the first network request is made.
 */
export type AdSlotVariant =
  /** A column beside the page content, for a skyscraper/vertical creative. */
  | 'rail'
  /** The space under the folded settings, for a wide banner. */
  | 'banner'
  /** The layer behind a conversation, for a full-bleed background creative. */
  | 'chat-background';

export function AdSlot({ variant, className }: { variant: AdSlotVariant; className?: string }) {
  return (
    <div
      aria-hidden="true"
      // A stable hook for the (future) advertising layer, not for tests. `variant` is
      // repeated as an attribute so a stylesheet or an integration can target the two
      // slots without depending on the class names.
      data-ad-slot={variant}
      className={cn(
        variant === 'chat-background' && 'pointer-events-none absolute inset-0',
        variant === 'banner' && 'h-full w-full',
        className,
      )}
    />
  );
}
