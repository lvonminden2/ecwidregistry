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
      text: '$label.title.default',
    }),
    subtitle: content.default.inputbox({
      text: '$label.subtitle.default',
    }),
    server_url: content.default.inputbox({
      text: '$label.server_url.default',
    }),
    search_placeholder: content.default.inputbox({
      text: '$label.search_placeholder.default',
    }),
    add_to_cart_label: content.default.inputbox({
      text: '$label.add_to_cart_label.default',
    }),
    back_label: content.default.inputbox({
      text: '$label.back_label.default',
    }),
    empty_message: content.default.inputbox({
      text: '$label.empty_message.default',
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
