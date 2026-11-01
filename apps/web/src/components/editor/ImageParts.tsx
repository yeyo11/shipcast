import { useEffect, useId, useState } from 'react';
import { Overlay } from '../kit/Overlay';
import { ALT_MAX, describeImage, imagesWithoutAlt, type ImageSupport } from './images';

/*
 * The editor's images on the page (boards EditorImageInline and EditorImageDialog): a pasted or
 * dropped image is uploaded at once and asked for its alt text in place, under the bar; the bar's
 * Image button opens a 480 px dialog (a sheet on a phone) with the file and its description together.
 */

/**
 * Every image of the text that has no alt text yet, each with its field: the text cannot be saved
 * or prepared until each says what it shows
 */
export function MissingAlt({ value, onChange, images }: { value: string; onChange: (next: string) => void; images: ImageSupport }) {
  const missing = imagesWithoutAlt(value);
  if (missing.length === 0) return null;
  return (
    <div className="k-stack k-g8 ed-alts" role="group" aria-label="Images to describe">
      {missing.map((image) => (
        <AltField key={`${image.at}:${image.src}`} src={images.display(image.src)} onDescribe={(alt) => onChange(describeImage(value, image.at, alt))} />
      ))}
    </div>
  );
}

function AltField({ src, onDescribe }: { src: string; onDescribe: (alt: string) => void }) {
  const id = useId();
  const [alt, setAlt] = useState('');
  // Not a form: it sits inside the page's own (Write's), and a nested form is no form at all
  const describe = () => {
    if (alt.trim()) onDescribe(alt);
  };
  return (
    <div className="k-card k-hrow k-g12 ed-alt">
      <img className="ed-alt-thumb" src={src} alt="" />
      <div className="k-grow k-stack k-g4">
        <label className="k-lbl" htmlFor={id}>
          What does this image show?
        </label>
        <div className="k-hrow k-g8">
          <input
            id={id}
            className="k-input k-grow"
            value={alt}
            maxLength={ALT_MAX}
            onChange={(e) => setAlt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              describe();
            }}
            placeholder="Required: a reader who cannot see it gets this instead"
            autoFocus
          />
          <button type="button" className="k-btn k-sm" disabled={!alt.trim()} onClick={describe}>
            Describe
          </button>
        </div>
        <span className="k-xs k-muted">
          {alt.length} / {ALT_MAX}
        </span>
      </div>
    </div>
  );
}

/** The bar's Image button: choose a file, describe it, insert it at the caret */
export function ImageDialog({ open, onOpenChange, images, onInsert }: { open: boolean; onOpenChange: (open: boolean) => void; images: ImageSupport; onInsert: (image: { src: string; alt: string }) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [alt, setAlt] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setSrc(null);
    setAlt('');
    setProblem(null);
  }, [open]);
  return (
    <Overlay kind="dialog" label="Add an image" heading="Add an image" open={open} onOpenChange={onOpenChange}>
      <form
        className="k-stack k-g12"
        onSubmit={(e) => {
          e.preventDefault();
          // The dialog is a portal, but React bubbles its submit up to the page's own form (Write's), which would start the work
          e.stopPropagation();
          if (!src || !alt.trim()) return;
          onInsert({ src, alt: alt.trim() });
          onOpenChange(false);
        }}
      >
        <div className="k-field">
          <label className="k-lbl" htmlFor="ed-image-file">
            Image
          </label>
          <input
            id="ed-image-file"
            className="k-input"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setBusy(true);
              setProblem(null);
              const uploaded = await images.upload(file);
              setBusy(false);
              if (uploaded.ok) setSrc(uploaded.src);
              else setProblem(uploaded.problem);
            }}
          />
          <span className="k-help">PNG, JPEG, GIF or WebP, up to 20 MB; its metadata (camera, place) is removed</span>
        </div>
        {busy && (
          <p className="k-sm k-muted wr-flush" role="status">
            Uploading…
          </p>
        )}
        {problem && (
          <p className="k-sm wr-problem wr-flush" role="alert">
            {problem}
          </p>
        )}
        {src && <img className="ed-image-preview" src={images.display(src)} alt="" />}
        <div className="k-field">
          <label className="k-lbl" htmlFor="ed-image-alt">
            What it shows
          </label>
          <input id="ed-image-alt" className="k-input" value={alt} maxLength={ALT_MAX} onChange={(e) => setAlt(e.target.value)} required />
          <span className="k-help">
            Required, for readers who cannot see it · {alt.length} / {ALT_MAX}
          </span>
        </div>
        <button type="submit" className="k-btn k-pri" disabled={!src || !alt.trim() || busy}>
          Insert the image
        </button>
      </form>
    </Overlay>
  );
}
