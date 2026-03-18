import {
  content,
  design,
  showcase,
} from '@lightspeed/crane-api';

export default showcase.init({
  showcaseId: '1',
  blockName: '$label.showcase_1.blockName',
  content: {
    title: content.default.inputbox({
      text: 'Gift Registries',
    }),
    subtitle: content.default.inputbox({
      text: '',
    }),
    server_url: content.default.inputbox({
      text: 'https://ecwidregistry-production.up.railway.app',
    }),
    search_placeholder: content.default.inputbox({
      text: 'Search by name…',
    }),
    add_to_cart_label: content.default.inputbox({
      text: 'Add to cart',
    }),
    back_label: content.default.inputbox({
      text: 'Back',
    }),
    empty_message: content.default.inputbox({
      text: 'No registries found.',
    }),
  },
  design: {
    card_radius: design.default.selectbox({
      value: '4px',
    }),
    columns: design.default.selectbox({
      value: 'auto',
    }),
  },
});
