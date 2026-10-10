import type { AlbumCard } from "./api";
import Cover from "./Cover";

type Props = {
  albums: AlbumCard[];
  /** Opens the album page. */
  onOpen: (id: string) => void;
};

/** The collection, as a grid of covers. */
function Grid({ albums, onOpen }: Props) {
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
        <li key={album.id}>
          <button
            type="button"
            className="grid-album"
            aria-label={`Open ${album.title} by ${album.artist}`}
            onClick={() => onOpen(album.id)}
          >
            <Cover album={album} className="grid-cover" />
            <span className="grid-title">{album.title}</span>
            <span className="grid-artist">{album.artist}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default Grid;
