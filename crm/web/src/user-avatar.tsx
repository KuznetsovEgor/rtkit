import annaPhoto from '../public/avatars/anna.jpg';
import dmitryPhoto from '../public/avatars/dmitry.jpg';
import elenaPhoto from '../public/avatars/elena.jpg';
import alexeyPhoto from '../public/avatars/alexey.jpg';

const profilePhotos: Record<string, string> = {
  anna: annaPhoto,
  dmitry: dmitryPhoto,
  elena: elenaPhoto,
  alexey: alexeyPhoto,
};

function portraitKey(name: string) {
  const value = name.trim().toLocaleLowerCase('ru-RU');
  if (value.includes('анна орлова') || value === 'kam.anna') return 'anna';
  if (value.includes('дмитрий соколов') || value === 'kam.dmitry') return 'dmitry';
  if (value.includes('елена руководитель') || value === 'manager') return 'elena';
  if (value.includes('алексей администратор') || value === 'admin') return 'alexey';
  return null;
}

export function UserAvatar({ name, className = '' }: { name: string; className?: string }) {
  const key = portraitKey(name);
  const initial = name.trim().slice(0, 1).toLocaleUpperCase('ru-RU') || '?';

  return <span className={`qa-avatar ${className}`} aria-hidden="true">
    {key ? <img src={profilePhotos[key]} alt="" loading="lazy" decoding="async" /> : initial}
  </span>;
}
