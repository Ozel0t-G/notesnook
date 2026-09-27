/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

export interface GithubRelease {
  url: string;
  assets_url: string;
  upload_url: string;
  html_url: string;
  id: number;
  author: unknown;
  node_id: string;
  tag_name: string;
  target_commitish: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: Date;
  published_at: Date;
  assets: unknown[];
  tarball_url: string;
  zipball_url: string;
  body: string;
  mentions_count: number;
  reactions: unknown;
  discussion_url: string;
}
export type GithubVersionInfo = {
  version: string | null;
  releasedAt: string;
  notes: string;
  body: string;
  url: string;
  lastChecked: string;
  needsUpdate: boolean;
  current: string;
};
export const getGithubVersion = async (): Promise<GithubVersionInfo | null> => {
  // No VeyraN-owned mobile release feed is configured. An upstream release
  // must never be offered as an update to this product.
  return null;
};
