// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiError.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.Globalization;

using Domain.Abstractions;

namespace UI.ManagementApi;

/// <summary>
///   An expected Management API failure: the stable code that goes in <see cref="Result.Details" />, its category and
///   the message the Admin sees.
/// </summary>
/// <param name="Code">The stable error code, such as <c>User.NotFound</c>.</param>
/// <param name="Category">The failure category.</param>
/// <param name="Message">The human-readable message.</param>
internal sealed record ManagementApiError(string Code, ResultErrorCode Category, string Message)
{
	/// <summary>The stable code of a call Auth0 or the client-side limiter is rate limiting.</summary>
	public const string RateLimitedCode = "ManagementApi.RateLimited";

	/// <summary>A User the call names doesn't exist.</summary>
	public static readonly ManagementApiError UserNotFound =
		new("User.NotFound", ResultErrorCode.NotFound, "This User no longer exists in the Tenant.");

	/// <summary>A Role the call names doesn't exist.</summary>
	public static readonly ManagementApiError RoleNotFound =
		new("Role.NotFound", ResultErrorCode.NotFound, "This Role no longer exists in the Tenant.");

	/// <summary>Auth0 couldn't parse the search query.</summary>
	public static readonly ManagementApiError SearchInvalid =
		new("User.SearchInvalid", ResultErrorCode.Validation, "Auth0 couldn't run that search. Change the search text and try again.");

	/// <summary>The search ran over Auth0's time limit.</summary>
	public static readonly ManagementApiError SearchTooBroad =
		new("User.SearchTooBroad", ResultErrorCode.Validation, "That search took Auth0 too long. Narrow the search.");

	/// <summary>Another User already has the email address.</summary>
	public static readonly ManagementApiError EmailInUse =
		new("User.EmailInUse", ResultErrorCode.Conflict, "Another User already has that email address.");

	/// <summary>A Role with the name already exists.</summary>
	public static readonly ManagementApiError RoleAlreadyExists =
		new("Role.AlreadyExists", ResultErrorCode.Conflict, "A Role with that name already exists.");

	/// <summary>
	///   Auth0 refused to change a Profile Field, carrying Auth0's own reason.
	/// </summary>
	/// <param name="auth0Message">Auth0's message.</param>
	/// <returns>A <c>User.FieldNotEditable</c> error.</returns>
	public static ManagementApiError FieldNotEditable(string? auth0Message)
	{
		return new ManagementApiError("User.FieldNotEditable", ResultErrorCode.Validation,
			string.IsNullOrWhiteSpace(auth0Message)
				? "Auth0 won't change that field for this User."
				: $"Auth0 won't change that field for this User: {auth0Message}");
	}

	/// <summary>
	///   A rate-limited call, telling the Admin when to try again.
	/// </summary>
	/// <param name="reset">When Auth0's bucket refills, from <c>X-RateLimit-Reset</c>, or <see langword="null" /> when unknown.</param>
	/// <param name="now">The current time, from the injected <see cref="TimeProvider" />.</param>
	/// <returns>A <c>ManagementApi.RateLimited</c> error.</returns>
	public static ManagementApiError RateLimited(DateTimeOffset? reset, DateTimeOffset now)
	{
		string when = reset is null ? "a few seconds" : Seconds(RetrySeconds(reset.Value, now));

		return new ManagementApiError(RateLimitedCode, ResultErrorCode.RateLimited,
			$"Auth0 is rate limiting the app. Try again in {when}.");
	}

	/// <summary>
	///   The whole seconds until <paramref name="reset" />, rounded up and at least 1.
	/// </summary>
	/// <param name="reset">When Auth0's bucket refills.</param>
	/// <param name="now">The current time.</param>
	/// <returns>The seconds to wait.</returns>
	public static int RetrySeconds(DateTimeOffset reset, DateTimeOffset now)
	{
		double seconds = Math.Ceiling((reset - now).TotalSeconds);

		return seconds < 1 ? 1 : (int)Math.Min(seconds, int.MaxValue);
	}

	/// <summary>
	///   This error as a failed <see cref="Result{T}" />.
	/// </summary>
	/// <typeparam name="T">The value type.</typeparam>
	/// <returns>The failed result, with <see cref="Code" /> in <see cref="Result.Details" />.</returns>
	public Result<T> ToResult<T>()
	{
		return Result.Fail<T>(Message, Category, Code);
	}

	private static string Seconds(int seconds)
	{
		return seconds == 1 ? "1 second" : string.Create(CultureInfo.InvariantCulture, $"{seconds} seconds");
	}
}
