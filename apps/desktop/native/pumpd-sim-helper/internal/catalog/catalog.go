// Package catalog projects the pinned SimSlim library catalog into PUMPD's
// bounded helper protocol. SimSlim remains the only source of daemon labels,
// category metadata, overlap behavior, and restore-only services.
package catalog

import (
	"fmt"
	"sort"

	"github.com/mobai-app/simslim"
)

const (
	Version                      = "simslim-v0.8.0-09fc9cbb-pumpd.1-presets.2"
	UpstreamCommit               = "09fc9cbbca35db5230e6d571a0a366fe6876266e"
	UpstreamProfilesHash         = "e86e26967d4bf5e4ee33444066416330736ee7a4633ecf756cce15e801cdc0de"
	PatchSet                     = "pumpd.1"
	UpstreamSourceManifestSHA256 = "8a7681f26eb84be6b5a84a1326973c35c1ba4320e27c706655d3eed8bd31af08"
	PatchSHA256                  = "69bef9b9d08e900652acb77fd13463f6bc5f8735df1aa994ba6be6d353146083"
	VendoredSourceManifestSHA256 = "b2045d5332b79e52875d592189f37de2c817c12a341cddbb75499f3085b0e4c7"
)

type Category struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Downside       string   `json:"downside"`
	ApproxMemoryMB int      `json:"approxMemoryMB"`
	ServiceIDs     []string `json:"serviceIds"`
}

type Profile struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	Description         string   `json:"description"`
	CategoryIDs         []string `json:"categoryIds"`
	PreservedServiceIDs []string `json:"preservedServiceIds,omitempty"`
	Experimental        bool     `json:"experimental"`
}

// These jobs remained registered after reboot in real iOS 26.5 apply tests.
// Keep them enabled in PUMPD presets instead of weakening registration proof.
// They remain in the upstream mutation universe so legacy overrides can be restored.
var pumpdPreservedServiceIDs = []string{
	"com.apple.MapKit.SnapshotService",
	"com.apple.siri.acousticsignature",
	"com.apple.siri.context.service",
}

var profiles = []Profile{
	{
		ID: "pumpd-development", Name: "PUMPD Development",
		Description:         "A conservative profile that reduces nonessential background work while preserving common PUMPD development capabilities.",
		CategoryIDs:         []string{"siri", "family", "apps", "telemetry"},
		PreservedServiceIDs: pumpdPreservedServiceIDs,
		Experimental:        true,
	},
	{
		ID: "pumpd-ui-automation", Name: "PUMPD UI Automation",
		Description: "A stronger automation profile that preserves push, universal links, account and keychain, purchases, personal data, and health capabilities.",
		CategoryIDs: []string{
			"widgets", "siri", "search", "family", "photos", "apps", "messaging",
			"connectivity", "telemetry", "other",
		},
		PreservedServiceIDs: pumpdPreservedServiceIDs,
		Experimental:        true,
	},
	{
		ID: "maximum-density", Name: "Maximum Density",
		Description:  "The complete pinned SimSlim profile. Many simulator capabilities will stop working.",
		CategoryIDs:  categoryIDs(),
		Experimental: true,
	},
}

var legacyProfileAliases = map[string]string{
	"ui-automation":    "pumpd-ui-automation",
	"maximum-slimming": "maximum-density",
}

func Categories() []Category {
	out := make([]Category, 0, len(simslim.Categories))
	for _, category := range simslim.Categories {
		out = append(out, Category{
			ID:             category.ID,
			Name:           category.Name,
			Description:    category.Description,
			Downside:       category.Downside,
			ApproxMemoryMB: category.ApproxMemoryMB,
			ServiceIDs:     append([]string(nil), category.Labels...),
		})
	}
	return out
}

func Profiles() []Profile {
	out := make([]Profile, len(profiles))
	for i, profile := range profiles {
		out[i] = profile
		out[i].CategoryIDs = append([]string(nil), profile.CategoryIDs...)
		out[i].PreservedServiceIDs = append([]string(nil), profile.PreservedServiceIDs...)
	}
	return out
}

func ProfileByID(id string) (Profile, bool) {
	if canonicalID, aliased := legacyProfileAliases[id]; aliased {
		id = canonicalID
	}
	for _, profile := range profiles {
		if profile.ID == id {
			profile.CategoryIDs = append([]string(nil), profile.CategoryIDs...)
			profile.PreservedServiceIDs = append([]string(nil), profile.PreservedServiceIDs...)
			return profile, true
		}
	}
	return Profile{}, false
}

// ManagedServiceIDs is the exact mutation universe owned by pinned SimSlim.
// AlwaysEnabled labels are included only so legacy disabled state can be
// repaired; they are never part of a desired slim profile.
func ManagedServiceIDs() []string {
	set := simslim.SlimmableSet()
	for _, category := range simslim.Categories {
		for _, service := range category.AlwaysEnabled {
			set[service.Label] = true
		}
	}
	return sortedKeys(set)
}

func DesiredServiceIDs(profileID string) ([]string, error) {
	profile, ok := ProfileByID(profileID)
	if !ok {
		return nil, fmt.Errorf("unknown profile %q", profileID)
	}
	return desiredForCategories(profile.CategoryIDs, profile.PreservedServiceIDs...)
}

func desiredForCategories(categoryIDs []string, preservedServiceIDs ...string) ([]string, error) {
	selected := make(map[string]bool, len(categoryIDs))
	for _, id := range categoryIDs {
		if _, known := simslim.CategoryByID(id); !known {
			return nil, fmt.Errorf("unknown category %q", id)
		}
		selected[id] = true
	}
	except := make(map[string]bool)
	for _, category := range simslim.Categories {
		if !selected[category.ID] {
			except[category.ID] = true
		}
	}
	keep := make(map[string]bool, len(preservedServiceIDs))
	slimmable := simslim.SlimmableSet()
	for _, label := range preservedServiceIDs {
		if !slimmable[label] {
			return nil, fmt.Errorf("preserved service %q is absent from pinned SimSlim", label)
		}
		keep[label] = true
	}
	return sortedKeys(simslim.Profile{ExceptCategories: except, Keep: keep}.Desired()), nil
}

// UpstreamProfileForDesired converts a previously checkpointed PUMPD target
// into SimSlim's public profile type without reproducing its mutation engine.
func UpstreamProfileForDesired(desired []string) (simslim.Profile, error) {
	slimmable := simslim.SlimmableSet()
	wanted := make(map[string]bool, len(desired))
	for _, label := range desired {
		if !slimmable[label] {
			return simslim.Profile{}, fmt.Errorf("service %q is not slimmable in pinned SimSlim", label)
		}
		if wanted[label] {
			return simslim.Profile{}, fmt.Errorf("service %q is duplicated", label)
		}
		wanted[label] = true
	}
	keep := make(map[string]bool, len(slimmable)-len(wanted))
	for label := range slimmable {
		if !wanted[label] {
			keep[label] = true
		}
	}
	return simslim.Profile{Keep: keep}, nil
}

func categoryIDs() []string {
	ids := make([]string, 0, len(simslim.Categories))
	for _, category := range simslim.Categories {
		ids = append(ids, category.ID)
	}
	return ids
}

func sortedKeys(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for key, included := range set {
		if included {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}
