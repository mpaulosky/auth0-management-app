// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiOptions.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.ComponentModel.DataAnnotations;
using System.Diagnostics.CodeAnalysis;

namespace UI.ManagementApi;

/// <summary>
///   The Machine to Machine application's settings, bound from <c>Auth0:Management</c> and validated on startup. These
///   are never the sign-in application's <c>Auth0:*</c> credentials.
/// </summary>
[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes",
	Justification = "The options framework instantiates it when it binds Auth0:Management.")]
internal sealed class ManagementApiOptions
{
	/// <summary>
	///   The configuration section these options bind from.
	/// </summary>
	public const string SectionName = "Auth0:Management";

	/// <summary>
	///   The Tenant's domain, as a host only (for example <c>my-tenant.us.auth0.com</c>), with no scheme.
	/// </summary>
	[Required(ErrorMessage = "Auth0:Management:Domain is required. Set it in user secrets or the Auth0__Management__Domain environment variable.")]
	[RegularExpression(@"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$",
		ErrorMessage = "Auth0:Management:Domain must be the tenant's host only, such as my-tenant.us.auth0.com, with no scheme, port or path.")]
	public string Domain { get; set; } = string.Empty;

	/// <summary>
	///   The Machine to Machine application's client ID.
	/// </summary>
	[Required(ErrorMessage = "Auth0:Management:ClientId is required. Set it in user secrets or the Auth0__Management__ClientId environment variable.")]
	public string ClientId { get; set; } = string.Empty;

	/// <summary>
	///   The Machine to Machine application's client secret.
	/// </summary>
	[Required(ErrorMessage = "Auth0:Management:ClientSecret is required. Set it in user secrets or the Auth0__Management__ClientSecret environment variable.")]
	public string ClientSecret { get; set; } = string.Empty;

	/// <summary>
	///   The requests per second the client-side token bucket refills at. Defaults to the Free tier's 2.
	/// </summary>
	[Range(1, 100, ErrorMessage = "Auth0:Management:PermitsPerSecond must be from 1 to 100.")]
	public int PermitsPerSecond { get; set; } = 2;

	/// <summary>
	///   The client-side token bucket's size. Defaults to the Free tier's 2.
	/// </summary>
	[Range(1, 100, ErrorMessage = "Auth0:Management:Burst must be from 1 to 100.")]
	public int Burst { get; set; } = 2;

	/// <summary>
	///   How long a request waits for a token before the limiter answers it with its own 429. At most 4 s, so both of a
	///   call's attempts fit inside the SDK's 10 s timeout.
	/// </summary>
	[Range(typeof(TimeSpan), "00:00:01", "00:00:04", ParseLimitsInInvariantCulture = true,
		ErrorMessage = "Auth0:Management:QueueTimeout must be from 00:00:01 to 00:00:04.")]
	public TimeSpan QueueTimeout { get; set; } = TimeSpan.FromSeconds(4);
}
