import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { readBanner } from './banner';

/** The banner preference from the request's cookie, so the server draws the banner the owner left */
export const getBanner = createServerFn({ method: 'GET' }).handler(() => readBanner(getRequest().headers.get('cookie')));
