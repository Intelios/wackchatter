/**
 * A portrait, or the person's initial on a soft orb when there is no image.
 *
 * The fallback orb takes its colour from the shell's tokens (the character's for a
 * character, yours for a persona), so it never needs a colour of its own.
 */

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export function Avatar({
  url,
  name,
  size,
  who = 'char',
}: {
  url: string | null | undefined;
  name: string;
  size: AvatarSize;
  who?: 'char' | 'me';
}) {
  return (
    <span className={`w3-av w3-av--${size}`} data-who={who} aria-hidden="true">
      {url ? <img src={url} alt="" draggable={false} /> : <span>{initial(name)}</span>}
    </span>
  );
}

function initial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : '?';
}
