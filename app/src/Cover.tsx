import type { AlbumCard } from "./api";

type Props = {
  album: Pick<AlbumCard, "title" | "coverUrl">;
  className: string;
};

/**
 * The album's cover, shown as it is: Spotify's developer policy allows no
 * cropping, blur or overlay (RFC-001, "Spotify's attribution rules"). The
 * grid shows Spotify's, and the album page the high-res one when there is
 * one.
 */
function Cover({ album, className }: Props) {
  if (!album.coverUrl) {
    return (
      <div className={`${className} no-cover`} role="img" aria-label="No cover">
        {album.title}
      </div>
    );
  }
  return (
    <img
      className={className}
      src={album.coverUrl}
      alt={`Cover of ${album.title}`}
      loading="lazy"
    />
  );
}

export default Cover;
