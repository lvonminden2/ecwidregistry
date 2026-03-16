export interface Content {
  title: string;
  subtitle: string;
  server_url: string;
  search_placeholder: string;
  add_to_cart_label: string;
  back_label: string;
  empty_message: string;
}

export const content: Content = {
  title:               'Gift Registries',
  subtitle:            '',
  server_url:          'https://ecwidregistry-production.up.railway.app',
  search_placeholder:  'Search by name…',
  add_to_cart_label:   'Add to cart',
  back_label:          'Back',
  empty_message:       'No registries found.',
};
