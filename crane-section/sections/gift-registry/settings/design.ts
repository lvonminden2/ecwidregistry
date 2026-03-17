import { design } from '@lightspeed/crane-api';

export default {
  card_radius: design.selectbox({
    label: '$label.card_radius',
    options: [
      { value: '0px', label: '$label.radius_0' },
      { value: '4px', label: '$label.radius_4' },
      { value: '8px', label: '$label.radius_8' },
      { value: '12px', label: '$label.radius_12' },
      { value: '16px', label: '$label.radius_16' },
    ],
    defaults: { value: '4px' },
  }),
  columns: design.selectbox({
    label: '$label.columns',
    options: [
      { value: 'auto', label: '$label.columns_auto' },
      { value: '1', label: '$label.columns_1' },
      { value: '2', label: '$label.columns_2' },
      { value: '3', label: '$label.columns_3' },
      { value: '4', label: '$label.columns_4' },
    ],
    defaults: { value: 'auto' },
  }),
} as const;
