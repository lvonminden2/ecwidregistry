import type { Content } from '../settings/content';
import type { Design }  from '../settings/design';

export const showcase: { content: Partial<Content>; design: Partial<Design> } = {
  content: {
    title:    'Gift Registries',
    subtitle: 'Find and shop a registry',
  },
  design: {
    card_radius: '4px',
    columns:     'auto',
  },
};
