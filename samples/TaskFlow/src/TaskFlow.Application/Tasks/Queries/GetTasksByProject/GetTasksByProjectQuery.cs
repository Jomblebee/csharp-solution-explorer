using MediatR;

namespace TaskFlow.Application.Tasks.Queries.GetTasksByProject;

public record GetTasksByProjectQuery(int ProjectId) : IRequest<List<TaskDto>>;
