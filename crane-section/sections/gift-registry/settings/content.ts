import { content } from '@lightspeed/crane-api';

export default {
  title: content.inputbox({
    label: '$label.title',
    placeholder: '$label.title',
    defaults: { text: 'Gift Registries' },
  }),
  subtitle: content.inputbox({
    label: '$label.subtitle',
    placeholder: '$label.subtitle',
    defaults: { text: '' },
  }),
  server_url: content.inputbox({
    label: '$label.server_url',
    placeholder: '$label.server_url',
    defaults: { text: 'https://ecwidregistry-production.up.railway.app' },
  }),
  search_placeholder: content.inputbox({
    label: '$label.search_placeholder',
    placeholder: '$label.search_placeholder',
    defaults: { text: 'Search by name…' },
  }),
  add_to_cart_label: content.inputbox({
    label: '$label.add_to_cart_label',
    placeholder: '$label.add_to_cart_label',
    defaults: { text: 'Add to cart' },
  }),
  back_label: content.inputbox({
    label: '$label.back_label',
    placeholder: '$label.back_label',
    defaults: { text: 'Back' },
  }),
  empty_message: content.inputbox({
    label: '$label.empty_message',
    placeholder: '$label.empty_message',
    defaults: { text: 'No registries found.' },
  }),
} as const;
