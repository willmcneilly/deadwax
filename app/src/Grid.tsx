import type { AlbumCard } from "./api";
import Cover from "./Cover";

type Props = { albums: AlbumCard[] };

/** The collection, as a grid of covers. */
function Grid({ albums }: Props) {
  if (albums.length === 0) {
    return (
      <p className="empty">
        Your collection is empty. Search for an album to add it.
      </p>
    );
  }
  return (
    <ul className="grid" aria-label="Your collection">
      {albums.map((album) => (
        <li key={album.id} className="grid-album">
          <Cover album={album} className="grid-cover" />
          <span className="grid-title">{album.title}</span>
          <span className="grid-artist">{album.artist}</span>
        </li>
      ))}
    </ul>
  );
}

export default Grid;
