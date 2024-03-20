/**
 * @file
 * This file is part of AdGuard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * AdGuard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * AdGuard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with AdGuard Browser Extension. If not, see <http://www.gnu.org/licenses/>.
 */
import { filterVersionStorage, settingsStorage } from '../../storages';
import {
    SettingOption,
    RegularFilterMetadata,
    CustomFilterMetadata,
} from '../../schema';
import { DEFAULT_FILTERS_UPDATE_PERIOD } from '../../../common/settings';
import { Log } from '../../../common/log';
import { FiltersUpdateTime } from '../../../common/constants';
import { Engine } from '../../engine';
import { getErrorMessage } from '../../../common/error';

import { FilterMetadata, FiltersApi } from './main';
import { CustomFilterApi } from './custom';
import { CommonFilterApi } from './common';

/**
 * Filter update detail.
 */
export type FilterUpdateOptions = {
    /**
     * Filter identifier.
     */
    filterId: number,
    /**
     * Is it a force update or not.
     * Force update is when we update filters fully without patch updates.
     */
    force: boolean,
};

/**
 * List of filter update details.
 */
type FilterUpdateOptionsList = FilterUpdateOptions[];

/**
 * API for manual and automatic (by period) filter rules updates.
 */
export class FilterUpdateApi {
    /**
     * Timeout for recently checked (added, enabled or updated by the scheduler)
     * filters - 5 minutes.
     */
    private static readonly RECENTLY_CHECKED_FILTER_TIMEOUT_MS = 1000 * 60 * 5;

    /**
     * Filters the provided filter list with {@link selectFiltersIdsToUpdate},
     * then gets fresh metadata from the remote server for all filters (it
     * cannot be updated selectively), and, after updating, refreshes
     * lastCheckTime for each of those selected for checking filters.
     *
     * Called:
     * - by the user's action to enable a filter or a filter group (even when
     * a filter is enabled from the Stealth menu);
     * - when the language filter is automatically turned on.
     *
     * @param filterIds List of filter ids to check.
     *
     * @returns List of metadata for updated filters.
     */
    public static async checkForFiltersUpdates(filterIds: number[]): Promise<FilterMetadata[]> {
        const filtersToCheck = FilterUpdateApi.selectFiltersIdsToUpdate(filterIds);

        const updatedFilters = await FilterUpdateApi.updateFilters(
            // 'force' is 'true', because we update filters fully (without patches) when we enable groups.
            filtersToCheck.map((id) => ({ filterId: id, force: true })),
        );

        filterVersionStorage.refreshLastCheckTime(filtersToCheck);

        return updatedFilters;
    }

    /**
     * If filtering is disabled or there is no selected filter update period in
     * the settings and if it is not a forced update, it returns an empty array.
     * Otherwise it checks all installed and enabled filters and only those that
     * have their group enabled for available updates: if it is a forced
     * update - it checks for updates for those (described above) filters,
     * otherwise it additional checks those filters for possible expose by
     * comparing 'lastTimeCheck' of each filter with updatePeriod from settings
     * or by checking 'expires' field.
     *
     * After that gets fresh metadata from the remote server for all filters (it
     * cannot be updated selectively).
     *
     * 'Installed filters' are filters whose rules are loaded in
     * browser.storage.local.
     *
     * Called when user manually run update:
     * - on request from context menu;
     * - on request from popup menu;
     *
     * Or from the update scheduler @see FilterUpdateService.
     *
     * @param forceUpdate Is it a force manual check by user action or first run
     * or not.
     */
    public static async autoUpdateFilters(forceUpdate: boolean = false): Promise<FilterMetadata[]> {
        const startUpdateLogMessage = forceUpdate
            ? 'Update filters forced by user.'
            : 'Update filters by scheduler.';
        Log.info(startUpdateLogMessage);

        // If filtering is disabled, and it is not a forced update, it does nothing.
        const filteringDisabled = settingsStorage.get(SettingOption.DisableFiltering);
        if (filteringDisabled && !forceUpdate) {
            return [];
        }

        const updatePeriod = settingsStorage.get(SettingOption.FiltersUpdatePeriod);
        // Auto update disabled.
        if (updatePeriod === FiltersUpdateTime.Disabled && !forceUpdate) {
            return [];
        }

        // Selects to check only installed and enabled filters and only those
        // that have their group enabled.
        const installedAndEnabledFilters = FiltersApi.getInstalledAndEnabledFiltersIds();

        // If it is a force check - updates all installed and enabled filters.
        let filterUpdateDetailsToUpdate = installedAndEnabledFilters.map(
            id => ({ filterId: id, force: forceUpdate }),
        );

        // If not a force check - updates only outdated filters.
        if (!forceUpdate) {
            // Select filters with diff paths and mark them for no force update
            const filtersToPatchUpdate = FilterUpdateApi.selectFiltersToPatchUpdate(filterUpdateDetailsToUpdate);

            // Select filters for a forced update and mark them accordingly
            const filtersToFullUpdate = FilterUpdateApi.selectFiltersToFullUpdate(
                filterUpdateDetailsToUpdate,
                updatePeriod,
            );

            // Combine both arrays
            const combinedFilters = [...filtersToPatchUpdate, ...filtersToFullUpdate];

            const uniqueFiltersMap = new Map();

            combinedFilters.forEach(filter => {
                if (!uniqueFiltersMap.has(filter.filterId) || filter.force) {
                    uniqueFiltersMap.set(filter.filterId, filter);
                }
            });

            filterUpdateDetailsToUpdate = Array.from(uniqueFiltersMap.values());
        }

        const updatedFilters = await FilterUpdateApi.updateFilters(filterUpdateDetailsToUpdate);

        // Updates last check time of all installed and enabled filters,
        // which where updated with force
        filterVersionStorage.refreshLastCheckTime(
            filterUpdateDetailsToUpdate
                .filter(filterUpdateOptions => filterUpdateOptions.force)
                .map(({ filterId }) => filterId),
        );

        // If some filters were updated, then it is time to update the engine.
        if (updatedFilters.length > 0) {
            Engine.debounceUpdate();
        }

        return updatedFilters;
    }

    /**
     * Updates the metadata of all filters and updates the filter contents from
     * the provided list of identifiers.
     *
     * @param filterUpdateOptionsList List of filters ids to update.
     *
     * @returns Promise with a list of updated {@link FilterMetadata filters' metadata}.
     */
    private static async updateFilters(
        filterUpdateOptionsList: FilterUpdateOptionsList,
    ): Promise<FilterMetadata[]> {
        /**
         * Reload common filters metadata from backend for correct
         * version matching on update check.
         * We do not update metadata on each check if there are no filters or only custom filters.
         */
        const shouldLoadMetadata = filterUpdateOptionsList.some(filterUpdateOptions => {
            return filterUpdateOptions.force && CommonFilterApi.isCommonFilter(filterUpdateOptions.filterId);
        });

        if (shouldLoadMetadata) {
            try {
                await FiltersApi.loadMetadata(true);
            } catch (e) {
                // No need to throw an error here,
                // because we can still load filters using the old metadata.
                Log.error('Failed to load metadata due to an error:', getErrorMessage(e));
            }
        }

        const updatedFiltersMetadata: FilterMetadata[] = [];

        const updateTasks = filterUpdateOptionsList.map(async (filterData) => {
            let filterMetadata: CustomFilterMetadata | RegularFilterMetadata | null;

            if (CustomFilterApi.isCustomFilter(filterData.filterId)) {
                filterMetadata = await CustomFilterApi.updateFilter(filterData);
            } else {
                filterMetadata = await CommonFilterApi.updateFilter(filterData);
            }

            if (filterMetadata) {
                updatedFiltersMetadata.push(filterMetadata);
            }
        });

        const promises = await Promise.allSettled(updateTasks);

        // Handles errors
        promises.forEach((promise) => {
            if (promise.status === 'rejected') {
                Log.error('Cannot update filter due to: ', promise.reason);
            }
        });

        return updatedFiltersMetadata;
    }

    /**
     * Selects from the provided list of filters only those that have not been
     * {@link RECENTLY_CHECKED_FILTER_TIMEOUT_MS recently} updated (added,
     * enabled or updated by the scheduler) and those that are custom filters.
     *
     * @param filterIds List of filter ids.
     *
     * @returns List of filter ids to update.
     */
    private static selectFiltersIdsToUpdate(filterIds: number[]): number[] {
        const filterVersions = filterVersionStorage.getData();

        return filterIds.filter((id: number) => {
            // Always check for updates for custom filters
            const isCustom = CustomFilterApi.isCustomFilter(Number(id));

            // Select only not recently checked filters
            const filterVersion = filterVersions[Number(id)];
            const outdated = filterVersion !== undefined
                ? Date.now() - filterVersion.lastCheckTime > FilterUpdateApi.RECENTLY_CHECKED_FILTER_TIMEOUT_MS
                : true;

            return isCustom || outdated;
        });
    }

    /**
     * Selects filters to update with patches. Such filters should
     * 1. Have `diffPath`
     * 2. Not have `shouldWaitFullUpdate` flag which means that patch update failed previously.
     *
     * @param filterUpdateOptionsList Filter update details.
     *
     * @returns List with filter update details, which have diff path.
     */
    private static selectFiltersToPatchUpdate(
        filterUpdateOptionsList: FilterUpdateOptionsList,
    ): FilterUpdateOptionsList {
        const filterVersions = filterVersionStorage.getData();

        return filterUpdateOptionsList
            .filter((filterData) => {
                const filterVersion = filterVersions[filterData.filterId];
                // we do not check here expires, since @adguard/filters-downloader does it.
                return filterVersion?.diffPath
                    // filter may have diffPath but if patch update failed previously,
                    // we should not try to update it with patches again to avoid continuous failures of patch requests
                    // and wait until full update
                    // https://github.com/AdguardTeam/AdguardBrowserExtension/issues/2717
                    && !filterVersion?.shouldWaitFullUpdate;
            })
            .map(({ filterId }) => ({ filterId, force: false }));
    }

    /**
     * Selects outdated filters from the provided filter list for a full update.
     * The selecting is based on the provided filter update period from the settings.
     *
     * @param filterUpdateOptionsList List of filter update details.
     * @param updatePeriod Period of checking updates in ms.
     *
     * @returns List of outdated filter ids.
     */
    private static selectFiltersToFullUpdate(
        filterUpdateOptionsList: FilterUpdateOptionsList,
        updatePeriod: number,
    ): FilterUpdateOptionsList {
        const filterVersions = filterVersionStorage.getData();

        return filterUpdateOptionsList.filter((data) => {
            const filterVersion = filterVersions[data.filterId];

            if (!filterVersion) {
                return true;
            }

            const { lastCheckTime, expires } = filterVersion;

            // By default, checks the "expires" field for each filter.
            if (updatePeriod === DEFAULT_FILTERS_UPDATE_PERIOD) {
                // If it is time to check the update, adds it to the array.
                // IMPORTANT: "expires" in filter is specified in SECONDS.
                return lastCheckTime + expires * 1000 <= Date.now();
            }

            // Check, if the renewal period of each filter has passed.
            // If it is time to check the renewal, add to the array.
            return lastCheckTime + updatePeriod <= Date.now();
        }).map(({ filterId }) => ({ filterId, force: true }));
    }
}

// TODO remove later
// This method is exposed for the testing purposes.
// @ts-ignore
window.autoUpdate = FilterUpdateApi.autoUpdateFilters;
