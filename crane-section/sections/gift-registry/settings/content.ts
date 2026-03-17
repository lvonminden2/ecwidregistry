import { content } from '@lightspeed/crane-api';

export default {
  title: content.inputbox({
    label: '$label.title',
    placeholder: '$label.title',
    defaults: { text: '$label.title.default' },
  }),
  subtitle: content.inputbox({
    label: '$label.subtitle',
    placeholder: '$label.subtitle',
    defaults: { text: '$label.subtitle.default' },
  }),
  server_url: content.inputbox({
    label: '$label.server_url',
    placeholder: '$label.server_url',
    defaults: { text: '$label.server_url.default' },
  }),
  search_placeholder: content.inputbox({
    label: '$label.search_placeholder',
    placeholder: '$label.search_placeholder',
    defaults: { text: '$label.search_placeholder.default' },
  }),
  add_to_cart_label: content.inputbox({
    label: '$label.add_to_cart_label',
    placeholder: '$label.add_to_cart_label',
    defaults: { text: '$label.add_to_cart_label.default' },
  }),
  back_label: content.inputbox({
    label: '$label.back_label',
    placeholder: '$label.back_label',
    defaults: { text: '$label.back_label.default' },
  }),
  empty_message: content.inputbox({
    label: '$label.empty_message',
    placeholder: '$label.empty_message',
    defaults: { text: '$label.empty_message.default' },
  }),
} as const;
