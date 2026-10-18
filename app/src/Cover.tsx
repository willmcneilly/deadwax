type Props = {
  album: { title: string; coverUrl: string | null };
  className: string;
};

/**
 * The album's cover, shown as it is: Spotify's developer policy allows no
 * cropping, blur or overlay (RFC-001, "Spotify's attribution rules"). Search
 * shows Spotify's, and now playing the album's 1600 from disk once it's
 * there.
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
